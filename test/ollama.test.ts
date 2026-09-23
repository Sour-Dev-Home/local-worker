import { describe, expect, it, vi } from "vitest";
import { chat, status, thinkSetting } from "../src/ollama.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("chat", () => {
  it("sends the model, context size and think level, and parses the reply", async () => {
    const fetchImpl = vi.fn(async () => json({ message: { content: " hello " }, total_duration: 2e9, prompt_eval_count: 10, eval_count: 3 }));
    const r = await chat({ baseUrl: "http://x", model: "gpt-oss:20b", system: "s", user: "u", numCtx: 9000, fetchImpl });
    expect(r).toEqual({ content: "hello", seconds: 2, promptTokens: 10, outputTokens: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://x/api/chat");
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ model: "gpt-oss:20b", stream: false, think: "low", options: { num_ctx: 9000 } });
    expect(sent.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
  });

  it("uses think:false for qwen3", () => {
    expect(thinkSetting("qwen3:14b")).toBe(false);
    expect(thinkSetting("gpt-oss:20b")).toBe("low");
  });

  it("surfaces HTTP errors and empty replies", async () => {
    await expect(
      chat({ baseUrl: "http://x", model: "m", system: "", user: "", numCtx: 1, fetchImpl: async () => new Response("model not found", { status: 404 }) }),
    ).rejects.toThrow(/Ollama 404: model not found/);
    await expect(chat({ baseUrl: "http://x", model: "m", system: "", user: "", numCtx: 1, fetchImpl: async () => json({ message: { content: "  " } }) })).rejects.toThrow(
      /empty response/,
    );
  });
});

describe("status", () => {
  it("summarizes installed and loaded models", async () => {
    const fetchImpl = async (url: string) => {
      if (url.endsWith("/api/version")) return json({ version: "0.34.3" });
      if (url.endsWith("/api/tags")) return json({ models: [{ name: "qwen3:14b", size: 9_300_000_000 }] });
      return json({ models: [{ name: "qwen3:14b", size: 10_000, size_vram: 7_500, context_length: 8192 }] });
    };
    await expect(status("http://x", fetchImpl)).resolves.toEqual({
      version: "0.34.3",
      installed: [{ name: "qwen3:14b", sizeGB: 9.3 }],
      loaded: [{ name: "qwen3:14b", gpuPercent: 75, contextLength: 8192 }],
    });
  });
});
