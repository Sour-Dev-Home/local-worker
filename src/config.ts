import path from "node:path";

export const MODELS = ["gpt-oss:20b", "qwen3:14b"] as const;
export type ModelName = (typeof MODELS)[number];

export interface Config {
  ollamaUrl: string;
  defaultModel: ModelName;
  /** Upper bound on the context window we ask Ollama for, in tokens. Bounded by VRAM, not just the model. */
  maxCtx: number;
  /** Absolute directories that files may be read from and written to. */
  roots: string[];
  /** Candidate Chromium-based browser executables for render_pdf, tried in order. */
  browsers: string[];
  platform: NodeJS.Platform;
}

const DEFAULT_BROWSERS: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"],
};

export interface ConfigSources {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
}

/**
 * Reads configuration from the environment. Every setting is optional:
 * - OLLAMA_URL            default http://127.0.0.1:11434
 * - LOCAL_WORKER_MODEL    default gpt-oss:20b (must be one of MODELS)
 * - LOCAL_WORKER_MAX_CTX  default 32768; integer >= 8192
 * - LOCAL_WORKER_ROOTS    path-delimiter-separated (";" on Windows, ":" elsewhere) allowed
 *                         directories. Default: only the server's working directory —
 *                         deliberately narrow; widen it explicitly. (The OS temp dir is
 *                         not a default: on Linux it's world-writable, so other local
 *                         users could plant files or links there.)
 * - LOCAL_WORKER_BROWSER  a browser executable to use for render_pdf, tried first
 */
export function loadConfig(sources: ConfigSources = {}): Config {
  const env = sources.env ?? process.env;
  const platform = sources.platform ?? process.platform;
  const api = platform === "win32" ? path.win32 : path.posix;

  const maxCtxRaw = env.LOCAL_WORKER_MAX_CTX ?? "32768";
  const maxCtx = Number(maxCtxRaw);
  if (!Number.isInteger(maxCtx) || maxCtx < 8192) {
    throw new Error(`LOCAL_WORKER_MAX_CTX must be an integer >= 8192, got "${maxCtxRaw}"`);
  }

  const model = env.LOCAL_WORKER_MODEL ?? "gpt-oss:20b";
  if (!(MODELS as readonly string[]).includes(model)) {
    throw new Error(`LOCAL_WORKER_MODEL must be one of ${MODELS.join(", ")}, got "${model}"`);
  }

  const rootList = env.LOCAL_WORKER_ROOTS
    ? env.LOCAL_WORKER_ROOTS.split(api.delimiter)
    : [sources.cwd ?? process.cwd()];
  const roots = rootList.map((r) => r.trim()).filter((r) => r.length > 0).map((r) => api.resolve(r));
  if (roots.length === 0) throw new Error("LOCAL_WORKER_ROOTS resolved to no directories");

  const browsers = [...(env.LOCAL_WORKER_BROWSER ? [env.LOCAL_WORKER_BROWSER] : []), ...(DEFAULT_BROWSERS[platform] ?? [])];

  return {
    ollamaUrl: (env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
    defaultModel: model as ModelName,
    maxCtx,
    roots,
    browsers,
    platform,
  };
}
