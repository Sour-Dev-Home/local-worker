// Independent (test-hunter) pass on the devlog CLI's output naming. The CLI is a top-level
// script, so it's driven by importing it with a stubbed argv, gh listing and model.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/devlog.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/devlog.js")>();
  return {
    ...real,
    listMergedPrs: vi.fn(async (repo: string) => [
      { number: repo.startsWith("alice/") ? 1 : 2, title: `from ${repo}`, body: "b", mergedAt: "2026-09-20T10:00:00Z", url: "u" },
    ]),
  };
});
vi.mock("../src/ollama.js", () => ({
  chat: vi.fn(async (req: { user: string }) => ({
    content: req.user.includes("alice/app") ? "Alice's week (#1)." : "Bob's week (#2).",
    seconds: 1,
    promptTokens: 0,
    outputTokens: 0,
  })),
}));

let out: string;
beforeAll(async () => {
  out = await fs.mkdtemp(path.join(os.tmpdir(), "lw-hunt-cli-"));
});
afterAll(async () => {
  await fs.rm(out, { recursive: true, force: true });
});

describe("devlog CLI", () => {
  it("keeps one draft per repo when two repos share a name under different owners", async () => {
    const savedArgv = process.argv;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = [process.execPath, "devlog-cli", "--repo", "alice/app", "--repo", "bob/app", "--out", out];
    try {
      await import("../src/devlog-cli.js").catch((e: Error) => {
        if (!e.message.startsWith("exit ")) throw e;
      });
    } finally {
      process.argv = savedArgv;
      exit.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
    const files = await fs.readdir(out);
    const contents = await Promise.all(files.map((f) => fs.readFile(path.join(out, f), "utf8")));
    const all = contents.join("\n");
    expect(all).toContain("Alice's week");
    expect(all).toContain("Bob's week");
  });
});
