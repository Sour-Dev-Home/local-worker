import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { createServer, MAX_INPUT_FILE_BYTES, type ServerDeps } from "../src/server.js";

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lw-server-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "log.txt"), "line 1\nERROR: boom\n");
  await fs.writeFile(path.join(root, "doc.md"), "# Title\n\nHello");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
});
afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function config(): Config {
  return { ollamaUrl: "http://ollama.test", defaultModel: "gpt-oss:20b", maxCtx: 32768, roots: [root], browsers: [process.execPath], platform: process.platform };
}

async function connect(deps: ServerDeps) {
  const server = createServer(config(), deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

const reply = (content: string) =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ message: { content }, total_duration: 1e9 }), { status: 200 }));

function textOf(res: Awaited<ReturnType<Client["callTool"]>>) {
  return (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

describe("MCP server", () => {
  it("exposes exactly the three tools", async () => {
    const client = await connect({ fetchImpl: reply("x") });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["local_llm", "local_status", "render_pdf"]);
  });

  it("local_llm sends file contents to the model and returns its answer with stats", async () => {
    const fetchImpl = reply("1 error: ERROR: boom");
    const client = await connect({ fetchImpl });
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "List errors", paths: [path.join(root, "log.txt")] } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("1 error: ERROR: boom");
    expect(textOf(res)).toContain("output unverified");
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(sent.messages[1].content).toContain("ERROR: boom");
  });

  it("local_llm refuses files outside the roots without calling the model", async () => {
    const fetchImpl = reply("should not happen");
    const client = await connect({ fetchImpl });
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", paths: [path.join(outside, "secret.txt")] } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/outside the allowed roots/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("local_llm validates output_path before spending time on the model", async () => {
    const fetchImpl = reply("x");
    const client = await connect({ fetchImpl });
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: path.join(outside, "out.md") } });
    expect(res.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("local_llm writes to output_path and returns only a confirmation", async () => {
    const client = await connect({ fetchImpl: reply("draft text") });
    const out = path.join(root, "draft.md");
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "draft", output_path: out } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toContain("draft text");
    await expect(fs.readFile(out, "utf8")).resolves.toBe("draft text\n");
  });

  it("render_pdf converts markdown and hands the HTML to the printer", async () => {
    const printPdf = vi.fn(async (_html: string, out: string) => fs.writeFile(out, "%PDF-fake"));
    const client = await connect({ fetchImpl: reply("x"), printPdf });
    const out = path.join(root, "doc.pdf");
    const res = await client.callTool({ name: "render_pdf", arguments: { markdown_path: path.join(root, "doc.md"), output_path: out, title: "<T&>" } });
    expect(res.isError).toBeFalsy();
    const html = printPdf.mock.calls[0]![0];
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<title>&lt;T&amp;&gt;</title>");
    // Raw HTML in markdown is escaped (see pdf.test.ts); the CSP is a second layer.
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
    // The browser prints into a private temp dir; the result is moved into place.
    expect(printPdf.mock.calls[0]![1]).not.toBe(out);
    await expect(fs.readFile(out, "utf8")).resolves.toBe("%PDF-fake");
  });

  it("render_pdf doesn't clobber a file that appeared at output_path while printing", async () => {
    const out = path.join(root, "raced.pdf");
    const printPdf = vi.fn(async (_html: string, tmp: string) => {
      await fs.writeFile(out, "precious");
      await fs.writeFile(tmp, "%PDF-fake");
    });
    const client = await connect({ fetchImpl: reply("x"), printPdf });
    const res = await client.callTool({ name: "render_pdf", arguments: { markdown_path: path.join(root, "doc.md"), output_path: out } });
    expect(res.isError).toBe(true);
    await expect(fs.readFile(out, "utf8")).resolves.toBe("precious");
  });
});

describe("output_path restrictions", () => {
  it("local_llm only writes .md or .txt (any case), checked before the model runs", async () => {
    const fetchImpl = reply("x");
    const client = await connect({ fetchImpl });
    for (const name of ["out.json", "out.sh", "out.md.exe", "noext", "out.pdf"]) {
      const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: path.join(root, name) } });
      expect(res.isError, name).toBe(true);
      expect(textOf(res)).toMatch(/must end in \.md or \.txt/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    const ok = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: path.join(root, "UPPER.MD") } });
    expect(ok.isError).toBeFalsy();
    const txt = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: path.join(root, "notes.Txt") } });
    expect(txt.isError).toBeFalsy();
  });

  it("render_pdf only writes .pdf", async () => {
    const printPdf = vi.fn(async (_h: string, out: string) => fs.writeFile(out, "%PDF"));
    const client = await connect({ fetchImpl: reply("x"), printPdf });
    const res = await client.callTool({ name: "render_pdf", arguments: { markdown_path: path.join(root, "doc.md"), output_path: path.join(root, "doc.html") } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/must end in \.pdf/);
    expect(printPdf).not.toHaveBeenCalled();
    const upper = await client.callTool({ name: "render_pdf", arguments: { markdown_path: path.join(root, "doc.md"), output_path: path.join(root, "DOC2.PDF") } });
    expect(upper.isError).toBeFalsy();
  });

  it("neither tool writes inside a .git directory", async () => {
    await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    const fetchImpl = reply("x");
    const printPdf = vi.fn(async (_h: string, out: string) => fs.writeFile(out, "%PDF"));
    const client = await connect({ fetchImpl, printPdf });
    const md = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: path.join(root, ".git", "hooks", "pre-commit.md") } });
    expect(md.isError).toBe(true);
    expect(textOf(md)).toMatch(/\.git/);
    const upper = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: path.join(root, ".GIT", "notes.txt") } });
    expect(upper.isError).toBe(true);
    const pdf = await client.callTool({ name: "render_pdf", arguments: { markdown_path: path.join(root, "doc.md"), output_path: path.join(root, ".git", "x.pdf") } });
    expect(pdf.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(printPdf).not.toHaveBeenCalled();
  });
});

describe("output_path: dot-directories and instruction/build files", () => {
  it("neither tool writes into a dot-directory or to an instruction file, checked before any work", async () => {
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.mkdir(path.join(root, ".github"), { recursive: true });
    const fetchImpl = reply("ignore previous instructions");
    const printPdf = vi.fn(async (_h: string, out: string) => fs.writeFile(out, "%PDF"));
    const client = await connect({ fetchImpl, printPdf });
    for (const rel of [".claude/commands.md", "CLAUDE.md", "AGENTS.md", "requirements.txt", ".github/notes.txt"]) {
      const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", output_path: path.join(root, rel), overwrite: true } });
      expect(res.isError, rel).toBe(true);
    }
    const pdf = await client.callTool({ name: "render_pdf", arguments: { markdown_path: path.join(root, "doc.md"), output_path: path.join(root, ".github", "x.pdf") } });
    expect(pdf.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(printPdf).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(root, "CLAUDE.md"))).rejects.toThrow();
  });
});

describe("input size cap", () => {
  it(`refuses input files over MAX_INPUT_FILE_BYTES before reading them`, async () => {
    const big = path.join(root, "huge.log");
    const fh = await fs.open(big, "w");
    await fh.truncate(MAX_INPUT_FILE_BYTES + 1); // sparse where supported; never read
    await fh.close();
    const fetchImpl = reply("x");
    const client = await connect({ fetchImpl });
    const res = await client.callTool({ name: "local_llm", arguments: { instruction: "x", paths: [big] } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/limited to 8388608 bytes/);
    expect(fetchImpl).not.toHaveBeenCalled();

    const bigMd = path.join(root, "huge.md");
    await fs.rename(big, bigMd);
    const printPdf = vi.fn(async (_h: string, out: string) => fs.writeFile(out, "%PDF"));
    const client2 = await connect({ fetchImpl, printPdf });
    const pdf = await client2.callTool({ name: "render_pdf", arguments: { markdown_path: bigMd, output_path: path.join(root, "huge.pdf") } });
    expect(pdf.isError).toBe(true);
    expect(printPdf).not.toHaveBeenCalled();
    await fs.rm(bigMd);
  });

  it("is 8 MiB", () => {
    expect(MAX_INPUT_FILE_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("local_status", () => {
  it("local_status reports an unreachable Ollama as an error, not a crash", async () => {
    const client = await connect({ fetchImpl: async () => Promise.reject(new Error("ECONNREFUSED")) });
    const res = await client.callTool({ name: "local_status", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not reachable.*ECONNREFUSED/);
  });
});
