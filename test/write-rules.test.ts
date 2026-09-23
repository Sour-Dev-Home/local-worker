// Round-2 hardening: write-name rules (dot-directories, agent-instruction and build
// files), the no-clobber commit, temp-file cleanup, and confined reads.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isUnderRoot, PathDeniedError, readConfinedFile, resolveWritable, safeWriteFile } from "../src/paths.js";

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lw-write-rules-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  for (const d of [".claude", ".github/workflows", ".vscode", ".cursor", ".husky", "docs"]) {
    await fs.mkdir(path.join(root, d), { recursive: true });
  }
  await fs.mkdir(outside);
});
afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const leftoverTemps = async (dir: string) => (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));

describe("write-name rules (persisted prompt injection)", () => {
  it("rejects any dot-directory below the root", async () => {
    for (const rel of [".claude/notes.md", ".github/workflows/ci.txt", ".vscode/x.md", ".cursor/rules.md", ".husky/pre-commit.txt"]) {
      await expect(resolveWritable(path.join(root, rel), [root], false), rel).rejects.toThrow(/dot-directory/);
    }
  });

  it("rejects dotfiles", async () => {
    await expect(resolveWritable(path.join(root, ".cursorrules.md"), [root], false)).rejects.toThrow(/dot/);
    await expect(resolveWritable(path.join(root, "docs", ".notes.txt"), [root], false)).rejects.toThrow(/dot/);
  });

  it("allows a root that itself sits under a dot-directory (the operator chose it)", async () => {
    const dotRoot = path.join(root, ".claude");
    await expect(resolveWritable(path.join(dotRoot, "ok.md"), [dotRoot], false)).resolves.toBe(path.join(dotRoot, "ok.md"));
  });

  it("rejects agent-instruction and build files in any case and directory", async () => {
    const names = [
      "CLAUDE.md",
      "claude.MD",
      "CLAUDE.local.md",
      "AGENTS.md",
      "agents.md",
      "GEMINI.md",
      "CMakeLists.txt",
      "cmakelists.TXT",
      "requirements.txt",
      "requirements-dev.txt",
      "Requirements_test.txt",
      "constraints.txt",
      "constraints-py312.txt",
    ];
    for (const n of names) {
      await expect(resolveWritable(path.join(root, n), [root], false), n).rejects.toThrow(/instruction or build file/);
      await expect(resolveWritable(path.join(root, "docs", n), [root], false), `docs/${n}`).rejects.toThrow(/instruction or build file/);
    }
  });

  it("rejects Win32 spellings that open an instruction file", async () => {
    // Trailing dots/spaces are dropped by Win32, so "CLAUDE.md." would create CLAUDE.md.
    await expect(resolveWritable(path.join(root, "CLAUDE.md."), [root], false)).rejects.toThrow(/instruction or build file/);
    await expect(resolveWritable(path.join(root, "AGENTS.md "), [root], false)).rejects.toThrow(/instruction or build file/);
  });

  it("still allows ordinary names", async () => {
    for (const n of ["notes.md", "claude-notes.md", "my-agents.md", "requirements.md", "docs/summary.txt"]) {
      await expect(resolveWritable(path.join(root, n), [root], false), n).resolves.toBeTruthy();
    }
  });

  it("safeWriteFile applies the same rules when handed a target directly", async () => {
    await expect(safeWriteFile(path.join(root, "CLAUDE.md"), "x", { roots: [root], overwrite: false })).rejects.toThrow(/instruction or build file/);
    await expect(safeWriteFile(path.join(root, ".claude", "x.md"), "x", { roots: [root], overwrite: false })).rejects.toThrow(/dot-directory/);
    expect(await fs.readdir(path.join(root, ".claude"))).toEqual([]);
  });
});

describe("safeWriteFile commit", () => {
  it("never clobbers a file that appears between the final check and the commit (overwrite: false)", async () => {
    const target = await resolveWritable(path.join(root, "late.md"), [root], false);
    const realCopy = fs.copyFile.bind(fs);
    vi.spyOn(fs, "copyFile").mockImplementation(async (src, dst, mode) => {
      await fs.writeFile(target, "precious"); // lands after checkDestination ran
      return realCopy(src, dst, mode);
    });
    await expect(safeWriteFile(target, "model output", { roots: [root], overwrite: false })).rejects.toThrow(/already exists/);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("precious");
    expect(await leftoverTemps(root)).toEqual([]);
  });

  it("doesn't use hard links (no rename fallback that could clobber on FAT/network filesystems)", async () => {
    const link = vi.spyOn(fs, "link");
    const target = await resolveWritable(path.join(root, "nolink.md"), [root], false);
    await safeWriteFile(target, "x", { roots: [root], overwrite: false });
    expect(link).not.toHaveBeenCalled();
    await expect(fs.readFile(target, "utf8")).resolves.toBe("x");
    expect((await fs.stat(target)).nlink).toBe(1);
  });

  it("removes the temp file when writing it fails partway", async () => {
    const target = await resolveWritable(path.join(root, "fails.md"), [root], false);
    await expect(safeWriteFile(target, 123 as unknown as string, { roots: [root], overwrite: false })).rejects.toThrow();
    expect(await leftoverTemps(root)).toEqual([]);
    await expect(fs.lstat(target)).rejects.toThrow();
  });

  it("leaves a pre-existing file alone when the temp name is already taken (EEXIST)", async () => {
    const target = await resolveWritable(path.join(root, "taken.md"), [root], false);
    const realOpen = fs.open.bind(fs);
    let squatted: string | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (p, flags, mode) => {
      if (flags === "wx" && String(p).endsWith(".tmp")) {
        squatted = String(p);
        await fs.writeFile(squatted, "someone else's");
        throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
      }
      return realOpen(p, flags, mode);
    });
    await expect(safeWriteFile(target, "x", { roots: [root], overwrite: false })).rejects.toThrow(/EEXIST/);
    await expect(fs.readFile(squatted!, "utf8")).resolves.toBe("someone else's");
    await fs.rm(squatted!);
  });
});

describe("readConfinedFile", () => {
  beforeAll(async () => {
    await fs.writeFile(path.join(root, "docs", "in.txt"), "inside");
    await fs.writeFile(path.join(outside, "in.txt"), "SECRET");
  });

  it("reads a file inside the root", async () => {
    await expect(readConfinedFile(path.join(root, "docs", "in.txt"), [root])).resolves.toEqual({ real: path.join(root, "docs", "in.txt"), text: "inside" });
  });

  it("refuses files outside the roots, directories and oversized files", async () => {
    await expect(readConfinedFile(path.join(outside, "in.txt"), [root])).rejects.toBeInstanceOf(PathDeniedError);
    await expect(readConfinedFile(path.join(root, "docs"), [root])).rejects.toThrow(/not a regular file/);
    await expect(readConfinedFile(path.join(root, "docs", "in.txt"), [root], process.platform, 5)).rejects.toThrow(/limited to 5 bytes/);
    await expect(readConfinedFile(path.join(root, "docs", "in.txt"), [root], process.platform, 6)).resolves.toMatchObject({ text: "inside" });
  });

  it("refuses to read when the parent is swapped for a link to outside between check and open", async (ctx) => {
    const dir = path.join(root, "swapread");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "in.txt"), "inside");
    const realOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (p, flags, mode) => {
      if (!swapped && String(p) === path.join(dir, "in.txt")) {
        await fs.rm(dir, { recursive: true });
        try {
          await fs.symlink(outside, dir, "junction");
          swapped = true;
        } catch {
          swapped = false;
        }
      }
      return realOpen(p, flags, mode);
    });
    const result = await readConfinedFile(path.join(dir, "in.txt"), [root]).then(
      (r) => r.text,
      (e: Error) => `error: ${e.message}`,
    );
    if (!swapped) ctx.skip();
    expect(result).not.toBe("SECRET");
    expect(result).toMatch(/^error: /);
  });

  it("refuses to read when the file is replaced by a different one between check and open", async () => {
    const f = path.join(root, "docs", "replaced.txt");
    await fs.writeFile(f, "first");
    const realOpen = fs.open.bind(fs);
    const realLstat = fs.lstat.bind(fs);
    let opened = false;
    vi.spyOn(fs, "open").mockImplementation(async (p, flags, mode) => {
      const fh = await realOpen(p, flags, mode);
      opened = true;
      return fh;
    });
    // After the handle is open, swap a different file into the path (new inode).
    vi.spyOn(fs, "lstat").mockImplementation((async (p: string, opts?: object) => {
      if (opened && p === f) {
        opened = false;
        await fs.rename(f, f + ".old");
        await fs.writeFile(f, "second");
      }
      return realLstat(p, opts as never);
    }) as typeof fs.lstat);
    await expect(readConfinedFile(f, [root])).rejects.toThrow(/changed while it was being opened/);
  });
});

describe("isUnderRoot: only BMP code points are case-folded", () => {
  it("doesn't fold astral letters (NTFS's upcase table is BMP-only)", () => {
    // DESERET CAPITAL LONG I (U+10400) / SMALL LONG I (U+10428).
    expect(isUnderRoot("C:\\\u{10428}\\x", ["C:\\\u{10400}"], "win32")).toBe(false);
    expect(isUnderRoot("C:\\\u{10400}\\x", ["C:\\\u{10400}"], "win32")).toBe(true);
    expect(isUnderRoot("C:\\\u00E9\\x", ["C:\\\u00C9"], "win32")).toBe(true); // é / É still fold
  });
});
