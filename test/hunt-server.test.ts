// Independent (test-hunter) pass on the MCP layer: argument edge cases and the gap between
// validating a destination and writing to it.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHARS_PER_TOKEN, RESERVED_TOKENS } from "../src/budget.js";
import type { Config } from "../src/config.js";
import { createServer, type ServerDeps } from "../src/server.js";

const isWin = process.platform === "win32";

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lw-hunt-server-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "small.txt"), "hello");
  await fs.writeFile(path.join(root, "doc.md"), "# T\n");
  await fs.writeFile(path.join(root, "big.log"), "HEAD\n" + "x".repeat(200_000) + "\nTAIL");
  await fs.writeFile(path.join(outside, "secret.md"), "# secret");
});
afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function config(over: Partial<Config> = {}): Config {
  return { ollamaUrl: "http://ollama.test", defaultModel: "gpt-oss:20b", maxCtx: 8192, roots: [root], browsers: [process.execPath], platform: process.platform, ...over };
}

async function connect(deps: ServerDeps, over: Partial<Config> = {}) {
  const server = createServer(config(over), deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

const ok = (content: string) => new Response(JSON.stringify({ message: { content }, total_duration: 1e9 }), { status: 200 });
const reply = (content: string) => vi.fn(async (_url: string, _init?: RequestInit) => ok(content));

function textOf(res: Awaited<ReturnType<Client["callTool"]>>) {
  return (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

async function exists(p: string) {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}

describe("local_llm argument validation", () => {
  it("rejects more than 20 paths without calling the model", async () => {
    const fetchImpl = reply("x");
    const client = await connect({ fetchImpl });
    const paths = Array.from({ length: 21 }, () => path.join(root, "small.txt"));
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", paths } });
    expect(res.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an empty instruction and an unknown model", async () => {
    const fetchImpl = reply("x");
    const client = await connect({ fetchImpl });
    expect((await client.callTool({ name: "local_llm", arguments: { instruction: "" } })).isError).toBe(true);
    expect((await client.callTool({ name: "local_llm", arguments: { instruction: "x", model: "llama3:70b" } })).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a directory as output_path before calling the model", async () => {
    const fetchImpl = reply("x");
    const client = await connect({ fetchImpl });
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: root } });
    expect(res.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an existing output_path without overwrite, before calling the model", async () => {
    const fetchImpl = reply("x");
    const client = await connect({ fetchImpl });
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: path.join(root, "small.txt") } });
    expect(res.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(root, "small.txt"), "utf8")).resolves.toBe("hello");
  });

  it.runIf(isWin)("rejects Windows device names as input paths", async () => {
    const fetchImpl = reply("x");
    const client = await connect({ fetchImpl });
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", paths: [path.join(root, "CON")] } });
    expect(res.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a model failure as an error and writes nothing", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = await connect({ fetchImpl });
    const out = path.join(root, "fail.md");
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: out } });
    expect(res.isError).toBe(true);
    expect(await exists(out)).toBe(false);
  });
});

describe("local_llm budgeting through the server", () => {
  it("never sends more than the context allows and reports truncation", async () => {
    const fetchImpl = reply("ok");
    const maxCtx = 8192;
    const client = await connect({ fetchImpl }, { maxCtx });
    const paths = [path.join(root, "big.log"), path.join(root, "small.txt"), path.join(root, "big.log")];
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "summarize", paths } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/TRUNCATED/);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    const user: string = sent.messages[1].content;
    expect(sent.options.num_ctx).toBeLessThanOrEqual(maxCtx);
    expect(user).toContain("hello"); // small file kept whole
    expect(user).toContain("TAIL");
    // Everything in the user message (instruction + framing + content) was supposed to fit
    // the content budget, which is (maxCtx - RESERVED_TOKENS) * CHARS_PER_TOKEN.
    expect(user.length).toBeLessThanOrEqual(Math.floor((maxCtx - RESERVED_TOKENS) * CHARS_PER_TOKEN));
  });
});

describe("local_llm: destination can change while the model runs (TOCTOU)", () => {
  // resolveWritable checks the destination BEFORE the model runs (by design, to fail fast),
  // but the model can take minutes. If the write doesn't re-check (or use O_EXCL / refuse
  // links at open time), the state checked is not the state written.

  it("does not clobber a file that appeared at output_path during the model run (overwrite: false)", async () => {
    const out = path.join(root, "race.md");
    const fetchImpl = vi.fn(async () => {
      await fs.writeFile(out, "precious"); // e.g. the user or another tool wrote it meanwhile
      return ok("model output");
    });
    const client = await connect({ fetchImpl });
    await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: out } });
    await expect(fs.readFile(out, "utf8")).resolves.toBe("precious");
  });

  it("does not write outside the roots if the parent directory is swapped for a junction during the run", async (ctx) => {
    const sub = path.join(root, "swap");
    await fs.mkdir(sub);
    const out = path.join(sub, "draft.md");
    let swapped = false;
    const fetchImpl = vi.fn(async () => {
      try {
        await fs.rm(sub, { recursive: true });
        await fs.symlink(outside, sub, "junction");
        swapped = true;
      } catch {
        swapped = false;
      }
      return ok("model output");
    });
    const client = await connect({ fetchImpl });
    await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: out } });
    if (!swapped) ctx.skip();
    expect(await exists(path.join(outside, "draft.md"))).toBe(false);
  });

  it("does not write through a symlink planted at output_path during the run", async (ctx) => {
    const out = path.join(root, "planted.md");
    const victim = path.join(outside, "victim.md");
    await fs.writeFile(victim, "untouched");
    let planted = false;
    const fetchImpl = vi.fn(async () => {
      try {
        await fs.symlink(victim, out, "file");
        planted = true;
      } catch {
        planted = false;
      }
      return ok("model output");
    });
    const client = await connect({ fetchImpl });
    await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: out, overwrite: true } });
    if (!planted) ctx.skip();
    await expect(fs.readFile(victim, "utf8")).resolves.toBe("untouched");
  });
});

describe("render_pdf argument validation", () => {
  it("refuses a markdown_path outside the roots without printing", async () => {
    const printPdf = vi.fn(async (_h: string, out: string) => fs.writeFile(out, "%PDF"));
    const client = await connect({ fetchImpl: reply("x"), printPdf });
    const res = await client.callTool({ name: "render_pdf", arguments: { markdown_path: path.join(outside, "secret.md"), output_path: path.join(root, "o.pdf") } });
    expect(res.isError).toBe(true);
    expect(printPdf).not.toHaveBeenCalled();
  });

  it("refuses an output_path outside the roots without printing", async () => {
    const printPdf = vi.fn(async (_h: string, out: string) => fs.writeFile(out, "%PDF"));
    const client = await connect({ fetchImpl: reply("x"), printPdf });
    const res = await client.callTool({ name: "render_pdf", arguments: { markdown_path: path.join(root, "doc.md"), output_path: path.join(outside, "o.pdf") } });
    expect(res.isError).toBe(true);
    expect(printPdf).not.toHaveBeenCalled();
    expect(await exists(path.join(outside, "o.pdf"))).toBe(false);
  });

  it("refuses to replace an existing PDF without overwrite", async () => {
    const existing = path.join(root, "exists.pdf");
    await fs.writeFile(existing, "old");
    const printPdf = vi.fn(async (_h: string, out: string) => fs.writeFile(out, "%PDF"));
    const client = await connect({ fetchImpl: reply("x"), printPdf });
    const res = await client.callTool({ name: "render_pdf", arguments: { markdown_path: path.join(root, "doc.md"), output_path: existing } });
    expect(res.isError).toBe(true);
    expect(printPdf).not.toHaveBeenCalled();
    await expect(fs.readFile(existing, "utf8")).resolves.toBe("old");
  });
});
