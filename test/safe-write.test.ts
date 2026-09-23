import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizeRoots, isUnderRoot, PathDeniedError, resolveWritable, safeWriteFile } from "../src/paths.js";

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lw-safe-write-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
});
afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

async function leftoverTemps(dir: string) {
  return (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
}

describe("safeWriteFile", () => {
  it("writes a new file and leaves no temp file behind", async () => {
    const target = await resolveWritable(path.join(root, "new.md"), [root], false);
    await safeWriteFile(target, "hello", { roots: [root], overwrite: false });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("hello");
    expect(await leftoverTemps(root)).toEqual([]);
  });

  it("replaces an existing file only with overwrite", async () => {
    const target = await resolveWritable(path.join(root, "replace.md"), [root], false);
    await safeWriteFile(target, "v1", { roots: [root], overwrite: false });
    await expect(safeWriteFile(target, "v2", { roots: [root], overwrite: false })).rejects.toThrow(/already exists/);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("v1");
    await safeWriteFile(target, "v2", { roots: [root], overwrite: true });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("v2");
    expect(await leftoverTemps(root)).toEqual([]);
  });

  it("refuses a file that appeared after validation (overwrite: false)", async () => {
    const target = await resolveWritable(path.join(root, "appeared.md"), [root], false);
    await fs.writeFile(target, "precious");
    await expect(safeWriteFile(target, "model output", { roots: [root], overwrite: false })).rejects.toThrow(/already exists/);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("precious");
    expect(await leftoverTemps(root)).toEqual([]);
  });

  it("refuses to write when the parent was swapped for a link to outside the roots", async (ctx) => {
    const sub = path.join(root, "swap");
    await fs.mkdir(sub);
    const target = await resolveWritable(path.join(sub, "draft.md"), [root], false);
    await fs.rm(sub, { recursive: true });
    try {
      await fs.symlink(outside, sub, "junction");
    } catch {
      ctx.skip();
    }
    await expect(safeWriteFile(target, "x", { roots: [root], overwrite: false })).rejects.toThrow(/changed|outside/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses to replace a file that gained another hard link after validation", async (ctx) => {
    const target = await resolveWritable(path.join(root, "linked.md"), [root], false);
    await fs.writeFile(target, "original");
    try {
      await fs.link(target, path.join(outside, "other-name.md"));
    } catch {
      ctx.skip();
    }
    await expect(safeWriteFile(target, "x", { roots: [root], overwrite: true })).rejects.toThrow(/hard links/);
    await expect(fs.readFile(path.join(outside, "other-name.md"), "utf8")).resolves.toBe("original");
  });

  it("refuses a target that became a directory", async () => {
    const target = await resolveWritable(path.join(root, "became-dir.md"), [root], false);
    await fs.mkdir(target);
    await expect(safeWriteFile(target, "x", { roots: [root], overwrite: true })).rejects.toThrow(/not a regular file/);
    expect(await leftoverTemps(root)).toEqual([]);
  });

  it("refuses a target outside the roots even if handed one directly", async () => {
    await expect(safeWriteFile(path.join(outside, "direct.md"), "x", { roots: [root], overwrite: false })).rejects.toBeInstanceOf(PathDeniedError);
    expect(await fs.readdir(outside)).not.toContain("direct.md");
  });
});

describe("resolveWritable: .git segments", () => {
  beforeAll(async () => {
    await fs.mkdir(path.join(root, "repo", ".git"), { recursive: true });
    await fs.mkdir(path.join(root, "repo", ".GIT"), { recursive: true }); // same dir on Windows/macOS
  });

  it("rejects any path with a .git segment, in any case", async () => {
    await expect(resolveWritable(path.join(root, "repo", ".git", "config.txt"), [root], true)).rejects.toThrow(/\.git/);
    await expect(resolveWritable(path.join(root, "repo", ".GIT", "hooks.md"), [root], true)).rejects.toThrow(/\.git/);
    await expect(resolveWritable(path.join(root, "repo", ".git"), [root], true)).rejects.toThrow();
  });

  it("rejects a .git file name even where no .git exists yet", async () => {
    await expect(resolveWritable(path.join(root, ".git"), [root], false)).rejects.toThrow(/\.git/);
    await expect(resolveWritable(path.join(root, ".Git"), [root], false)).rejects.toThrow(/\.git/);
  });

  it.runIf(process.platform === "win32")("rejects .git with either separator and Win32 trailing-dot spellings", async () => {
    await expect(resolveWritable(`${root}/repo/.git/x.md`, [root], true)).rejects.toThrow(/\.git/);
    await expect(resolveWritable(`${root}\\repo\\.git.\\x.md`, [root], true)).rejects.toThrow(/\.git/);
  });

  it("allows names that merely contain .git (but not dotfiles such as .gitignore.md)", async () => {
    await expect(resolveWritable(path.join(root, "repo", "notes.git.md"), [root], false)).resolves.toBeTruthy();
    await expect(resolveWritable(path.join(root, "repo", "git.md"), [root], false)).resolves.toBeTruthy();
    await expect(resolveWritable(path.join(root, "repo", ".gitignore.md"), [root], false)).rejects.toThrow(/dot/);
  });
});

describe("canonicalizeRoots", () => {
  it("realpaths existing roots and keeps missing ones as resolved paths", async () => {
    const missing = path.join(base, "does-not-exist");
    await expect(canonicalizeRoots([root, missing])).resolves.toEqual([root, missing]);
  });

  it("resolves a root that is a link to its target", async (ctx) => {
    const link = path.join(base, "root-link");
    try {
      await fs.symlink(root, link, "junction");
    } catch {
      ctx.skip();
    }
    await expect(canonicalizeRoots([link])).resolves.toEqual([root]);
  });
});

describe("isUnderRoot: case folding stays 1:1 and never maps non-ASCII to ASCII", () => {
  const W = (p: string, roots: string[]) => isUnderRoot(p, roots, "win32");

  it("does not fold multi-character or cross-ASCII mappings", () => {
    expect(W("C:\\ss\\x", ["C:\\\u00DF"])).toBe(false); // ß uppercases to "SS"
    expect(W("C:\\i\\x", ["C:\\\u0131"])).toBe(false); // dotless ı uppercases to ASCII "I"
    expect(W("C:\\s\\x", ["C:\\\u017F"])).toBe(false); // long ſ uppercases to ASCII "S"
  });

  it("still folds ASCII and ordinary non-ASCII letters", () => {
    expect(W("c:\\ROOT\\x", ["C:\\root"])).toBe(true);
    expect(W("C:\\\u00FCber\\x", ["C:\\\u00DCBER"])).toBe(true); // über / ÜBER
    expect(isUnderRoot("/\u00DCber/x", ["/\u00FCber"], "darwin")).toBe(true);
    expect(isUnderRoot("/\u00DCber/x", ["/\u00FCber"], "linux")).toBe(false);
  });
});
