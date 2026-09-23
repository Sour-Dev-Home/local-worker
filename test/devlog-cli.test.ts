// The CLI is a top-level script, so it's driven by importing it with a stubbed argv,
// gh listing and model (same approach as hunt-devlog-cli.test.ts).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/devlog.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/devlog.js")>();
  return {
    ...real,
    // One more than the limit: what listMergedPrs returns when gh's list was capped.
    listMergedPrs: vi.fn(async () =>
      Array.from({ length: real.PR_LIST_LIMIT + 1 }, (_, i) => ({
        number: i + 1,
        title: `PR ${i + 1}`,
        body: "b",
        mergedAt: "2026-09-20T10:00:00Z",
        url: "u",
      })),
    ),
  };
});
vi.mock("../src/ollama.js", () => ({
  chat: vi.fn(async () => ({ content: "A week (#1).", seconds: 1, promptTokens: 0, outputTokens: 0 })),
}));

let out: string;
beforeAll(async () => {
  out = await fs.mkdtemp(path.join(os.tmpdir(), "lw-cli-"));
});
afterAll(async () => {
  await fs.rm(out, { recursive: true, force: true });
});

describe("devlog CLI", () => {
  it("names drafts owner-name-week and warns in the header when the PR list was capped", async () => {
    const savedArgv = process.argv;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = [process.execPath, "devlog-cli", "--repo", "some-org/app", "--days", "90", "--out", out];
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
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^some-org-app-\d{4}-W\d{2}\.md$/);
    const draft = await fs.readFile(path.join(out, files[0]!), "utf8");
    const header = draft.slice(0, draft.indexOf("-->"));
    expect(header).toMatch(/WARNING: more than 100 PRs were merged/);
  });
});
