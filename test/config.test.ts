import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to the working directory as the only root (not the world-writable temp dir)", () => {
    const c = loadConfig({ env: {}, platform: "linux", cwd: "/proj" });
    expect(c.roots).toEqual(["/proj"]);
    expect(c.defaultModel).toBe("gpt-oss:20b");
    expect(c.maxCtx).toBe(32768);
    expect(c.ollamaUrl).toBe("http://127.0.0.1:11434");
  });

  it("splits LOCAL_WORKER_ROOTS on the platform delimiter", () => {
    expect(loadConfig({ env: { LOCAL_WORKER_ROOTS: "/a:/b/" }, platform: "linux" }).roots).toEqual(["/a", "/b"]);
    expect(loadConfig({ env: { LOCAL_WORKER_ROOTS: "C:\\a; D:\\b" }, platform: "win32" }).roots).toEqual(["C:\\a", "D:\\b"]);
  });

  it("rejects an empty root list", () => {
    expect(() => loadConfig({ env: { LOCAL_WORKER_ROOTS: " : " }, platform: "linux" })).toThrow(/no directories/);
  });

  it("validates the context size and model", () => {
    expect(() => loadConfig({ env: { LOCAL_WORKER_MAX_CTX: "4096" } })).toThrow(/>= 8192/);
    expect(() => loadConfig({ env: { LOCAL_WORKER_MAX_CTX: "abc" } })).toThrow();
    expect(() => loadConfig({ env: { LOCAL_WORKER_MODEL: "llama" } })).toThrow(/must be one of/);
  });

  it("strips trailing slashes from OLLAMA_URL and puts LOCAL_WORKER_BROWSER first", () => {
    const c = loadConfig({ env: { OLLAMA_URL: "http://gpu:11434//", LOCAL_WORKER_BROWSER: "/opt/chrome" }, platform: "linux" });
    expect(c.ollamaUrl).toBe("http://gpu:11434");
    expect(c.browsers[0]).toBe("/opt/chrome");
  });
});
