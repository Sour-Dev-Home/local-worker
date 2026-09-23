export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChatRequest {
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  numCtx: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface ChatResult {
  content: string;
  seconds: number;
  promptTokens: number;
  outputTokens: number;
}

/**
 * Hidden reasoning only costs local time, but these are simple bounded tasks, so keep it
 * short: gpt-oss takes a level, qwen3 takes a boolean.
 */
export function thinkSetting(model: string): "low" | false {
  return model.startsWith("gpt-oss") ? "low" : false;
}

export async function chat(req: ChatRequest): Promise<ChatResult> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const res = await fetchImpl(`${req.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(req.timeoutMs ?? 10 * 60 * 1000),
    body: JSON.stringify({
      model: req.model,
      stream: false,
      think: thinkSetting(req.model),
      options: { num_ctx: req.numCtx, temperature: 0.2 },
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const body = (await res.json()) as {
    message?: { content?: string };
    total_duration?: number;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const content = body.message?.content?.trim() ?? "";
  if (!content) throw new Error("Ollama returned an empty response");
  return {
    content,
    seconds: (body.total_duration ?? 0) / 1e9,
    promptTokens: body.prompt_eval_count ?? 0,
    outputTokens: body.eval_count ?? 0,
  };
}

export interface OllamaStatus {
  version: string;
  installed: { name: string; sizeGB: number }[];
  loaded: { name: string; gpuPercent: number; contextLength: number | null }[];
}

export async function status(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<OllamaStatus> {
  const get = async <T>(p: string): Promise<T> => {
    const res = await fetchImpl(`${baseUrl}${p}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Ollama ${p} returned ${res.status}`);
    return (await res.json()) as T;
  };
  const [ver, tags, ps] = await Promise.all([
    get<{ version: string }>("/api/version"),
    get<{ models?: { name: string; size: number }[] }>("/api/tags"),
    get<{ models?: { name: string; size: number; size_vram?: number; context_length?: number }[] }>("/api/ps"),
  ]);
  return {
    version: ver.version,
    installed: (tags.models ?? []).map((m) => ({ name: m.name, sizeGB: Math.round(m.size / 1e8) / 10 })),
    loaded: (ps.models ?? []).map((m) => ({
      name: m.name,
      gpuPercent: m.size ? Math.round((100 * (m.size_vram ?? 0)) / m.size) : 0,
      contextLength: m.context_length ?? null,
    })),
  };
}
