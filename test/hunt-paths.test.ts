// Independent (test-hunter) pass on the path-confinement boundary.
// Written from the README security model and the doc comments in src/paths.ts.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isUnderRoot, PathDeniedError, resolveReadable, resolveWritable } from "../src/paths.js";

const isWin = process.platform === "win32";

describe("isUnderRoot: win32 lexical escapes", () => {
  const W = (p: string, roots: string[]) => isUnderRoot(p, roots, "win32");

  it("rejects '..' with mixed separators", () => {
    expect(W("C:\\root/../x", ["C:\\root"])).toBe(false);
    expect(W("C:/root/../x", ["C:\\root"])).toBe(false);
    expect(W("C:\\root\\sub/..\\..\\x", ["C:\\root"])).toBe(false);
    expect(W("C:/root\\..", ["C:\\root"])).toBe(false);
  });

  it("accepts forward-slash spellings of paths that really are inside", () => {
    expect(W("C:/root/a.txt", ["C:\\root"])).toBe(true);
    expect(W("c:/ROOT/a.txt", ["C:\\root"])).toBe(true);
  });

  it("handles roots given with trailing separators", () => {
    expect(W("C:\\root\\a.txt", ["C:\\root\\"])).toBe(true);
    expect(W("C:\\root\\a.txt", ["C:/root/"])).toBe(true);
    expect(W("C:\\root", ["C:\\root\\"])).toBe(true);
    expect(W("C:\\rootx\\a.txt", ["C:\\root\\"])).toBe(false);
    expect(W("C:\\a.txt", ["C:\\root\\"])).toBe(false);
  });

  it("handles a trailing separator on the candidate path", () => {
    expect(W("C:\\root\\sub\\", ["C:\\root"])).toBe(true);
    expect(W("C:\\root\\..\\", ["C:\\root"])).toBe(false);
  });

  it("rejects sibling directories that share a prefix, in any case", () => {
    expect(W("C:\\root2\\x", ["C:\\root"])).toBe(false);
    expect(W("c:\\ROOT2\\x", ["C:\\root"])).toBe(false);
    expect(W("C:\\root.bak\\x", ["C:\\root"])).toBe(false);
  });

  it("treats a filesystem root as containing only its own drive", () => {
    expect(W("C:\\anything\\x", ["C:\\"])).toBe(true);
    expect(W("c:\\anything\\x", ["C:\\"])).toBe(true);
    expect(W("C:\\", ["C:\\"])).toBe(true);
    expect(W("D:\\anything", ["C:\\"])).toBe(false);
    expect(W("\\\\server\\share\\x", ["C:\\"])).toBe(false);
  });

  it("rejects drive-relative paths that point at another drive", () => {
    expect(W("D:foo", ["C:\\root"])).toBe(false);
    expect(W("D:..\\foo", ["C:\\root"])).toBe(false);
  });

  it("rejects drive-relative traversal on the same drive", () => {
    expect(W("C:..\\..\\..\\..\\..\\..\\Windows\\win.ini", ["C:\\root"])).toBe(false);
  });

  it("rejects a root-relative path (\\x) that resolves to the current drive root", () => {
    expect(W("\\Windows\\win.ini", ["C:\\root"])).toBe(false);
  });

  it("scopes UNC roots to the right server and share", () => {
    expect(W("\\\\server\\share\\x", ["\\\\server\\share"])).toBe(true);
    expect(W("\\\\server\\share\\x", ["\\\\server\\share\\"])).toBe(true);
    expect(W("\\\\server\\share2\\x", ["\\\\server\\share"])).toBe(false);
    expect(W("\\\\server2\\share\\x", ["\\\\server\\share"])).toBe(false);
    // ".." can't climb above a UNC share root (\\server\share\..\other == \\server\share\other),
    // so this one really is inside; but it must not reach a different share.
    expect(W("\\\\server\\share\\..\\other\\x", ["\\\\server\\share"])).toBe(true);
    expect(W("\\\\server\\share\\..\\..\\share2\\x", ["\\\\server\\share\\sub"])).toBe(false);
    expect(W("//server/share/x", ["\\\\server\\share"])).toBe(true);
  });

  it("does not let a \\\\?\\ or \\\\.\\ device path reach outside the root", () => {
    expect(W("\\\\?\\C:\\other\\x", ["C:\\root"])).toBe(false);
    expect(W("\\\\?\\D:\\root\\x", ["C:\\root"])).toBe(false);
    expect(W("\\\\.\\C:\\other\\x", ["C:\\root"])).toBe(false);
    expect(W("\\\\?\\C:\\root\\..\\other", ["C:\\root"])).toBe(false);
    expect(W("\\\\?\\UNC\\server\\share\\x", ["C:\\root"])).toBe(false);
    expect(W("\\\\.\\PhysicalDrive0", ["C:\\root"])).toBe(false);
  });

  // JS toLowerCase folds more than NTFS's upcase table does: KELVIN SIGN (U+212A) lowercases
  // to ASCII "k", but NTFS treats "\u212A" and "k" as different names. So a root named with a
  // Kelvin sign would admit its ASCII sibling. Exotic, but it's a boundary check.
  it("does not fold non-ASCII look-alikes into ASCII names (NTFS doesn't)", () => {
    expect(W("C:\\k\\secret.txt", ["C:\\\u212A"])).toBe(false);
    expect(W("C:\\data\\k\\secret.txt", ["C:\\data\\\u212A"])).toBe(false);
  });

  it("denies everything with no roots", () => {
    expect(W("C:\\root\\x", [])).toBe(false);
  });

  it("rejects the parent of the root", () => {
    expect(W("C:\\", ["C:\\root"])).toBe(false);
    expect(W("C:", ["C:\\root"])).toBe(false);
  });
});

describe("isUnderRoot: posix and darwin", () => {
  it("handles trailing slashes on roots and candidates", () => {
    expect(isUnderRoot("/work/a", ["/work/"], "linux")).toBe(true);
    expect(isUnderRoot("/work", ["/work/"], "linux")).toBe(true);
    expect(isUnderRoot("/work2/a", ["/work/"], "linux")).toBe(false);
    expect(isUnderRoot("/work/sub/", ["/work"], "linux")).toBe(true);
  });

  it("treats '/' as a root containing everything", () => {
    expect(isUnderRoot("/etc/passwd", ["/"], "linux")).toBe(true);
    expect(isUnderRoot("/", ["/"], "linux")).toBe(true);
  });

  it("rejects traversal spelled with repeated slashes and dot segments", () => {
    expect(isUnderRoot("/work//..//etc", ["/work"], "linux")).toBe(false);
    expect(isUnderRoot("/work/./../etc", ["/work"], "linux")).toBe(false);
    expect(isUnderRoot("/work/sub/../../etc", ["/work"], "linux")).toBe(false);
  });

  it("does not treat a backslash as a separator on posix (it's a legal filename byte)", () => {
    // "/work/..\\etc" is a file literally named "..\etc" inside /work on Linux.
    expect(isUnderRoot("/work/..\\etc", ["/work"], "linux")).toBe(true);
  });

  it("is case-insensitive on darwin, per the README", () => {
    expect(isUnderRoot("/Work/X", ["/work"], "darwin")).toBe(true);
    expect(isUnderRoot("/WORK2/x", ["/work"], "darwin")).toBe(false);
  });

  it("rejects relative candidates that are not inside the root", () => {
    expect(isUnderRoot("../etc/passwd", ["/work"], "linux")).toBe(false);
  });
});

describe("resolveReadable / resolveWritable: extra real-filesystem escapes", () => {
  let base: string;
  let root: string;
  let outside: string;
  let junctionOk = false;

  beforeAll(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lw-hunt-paths-")));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await fs.mkdir(path.join(root, "sub"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(root, "in.txt"), "inside");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    // Junctions are directory symlinks that don't need privileges on Windows.
    try {
      await fs.symlink(outside, path.join(root, "jx"), "junction");
      junctionOk = true;
    } catch {
      junctionOk = false;
    }
  });
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("denies reading through a directory junction/symlink that leaves the root", async (ctx) => {
    if (!junctionOk) ctx.skip();
    await expect(resolveReadable(path.join(root, "jx", "secret.txt"), [root])).rejects.toBeInstanceOf(PathDeniedError);
  });

  it("denies writing into a directory junction/symlink that leaves the root", async (ctx) => {
    if (!junctionOk) ctx.skip();
    await expect(resolveWritable(path.join(root, "jx", "new.txt"), [root], false)).rejects.toBeInstanceOf(PathDeniedError);
    await expect(resolveWritable(path.join(root, "jx", "secret.txt"), [root], true)).rejects.toBeInstanceOf(PathDeniedError);
  });

  it("denies writing onto the junction itself", async (ctx) => {
    if (!junctionOk) ctx.skip();
    await expect(resolveWritable(path.join(root, "jx"), [root], true)).rejects.toThrow();
  });

  it("accepts a root given with a trailing separator", async () => {
    await expect(resolveReadable(path.join(root, "in.txt"), [root + path.sep])).resolves.toBe(path.join(root, "in.txt"));
    await expect(resolveWritable(path.join(root, "t.txt"), [root + path.sep], false)).resolves.toBe(path.join(root, "t.txt"));
  });

  it("denies a write whose last component is '..' (lands on the root's parent)", async () => {
    await expect(resolveWritable(root + path.sep + "..", [root], true)).rejects.toThrow();
    await expect(resolveWritable(root + path.sep + "sub" + path.sep + ".." + path.sep + "..", [root], true)).rejects.toThrow();
  });

  it("denies a write whose last component is '.' (the root itself)", async () => {
    await expect(resolveWritable(root + path.sep + ".", [root], true)).rejects.toThrow();
  });

  it("denies an empty path", async () => {
    await expect(resolveReadable("", [root])).rejects.toThrow();
    await expect(resolveWritable("", [root], true)).rejects.toThrow();
  });

  it("denies writing to a path with a trailing separator (it names a directory)", async () => {
    await expect(resolveWritable(path.join(root, "newdir") + path.sep, [root], false)).rejects.toThrow();
  });

  it.runIf(isWin)("denies mixed-separator traversal against the real filesystem", async () => {
    const sneaky = root + "/sub/../../outside\\secret.txt";
    await expect(resolveReadable(sneaky, [root])).rejects.toBeInstanceOf(PathDeniedError);
    await expect(resolveWritable(root + "/../outside/new.txt", [root], false)).rejects.toBeInstanceOf(PathDeniedError);
  });

  it.runIf(isWin)("denies \\\\?\\ long-path spellings of files outside the root", async () => {
    await expect(resolveReadable("\\\\?\\" + path.join(outside, "secret.txt"), [root])).rejects.toThrow();
    await expect(resolveWritable("\\\\?\\" + path.join(outside, "new.txt"), [root], false)).rejects.toThrow();
  });

  it.runIf(isWin)("reads with a different letter case than the root (case-insensitive on Windows)", async () => {
    await expect(resolveReadable(path.join(root, "IN.TXT").toUpperCase(), [root.toLowerCase()])).resolves.toBeTruthy();
  });

  it.runIf(isWin)("denies Windows alternate data stream names that address outside files", async () => {
    // "file:stream" is always inside the same file, but make sure a stream on an outside
    // file can't be reached by spelling.
    await expect(resolveReadable(path.join(outside, "secret.txt") + ":$DATA", [root])).rejects.toThrow();
  });
});

describe("roots that are themselves links (usability, README: 'Symlinks are resolved before the check')", () => {
  let base: string;
  let real: string;
  let linkRoot: string;
  let ok = false;

  beforeAll(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lw-hunt-rootlink-")));
    real = path.join(base, "real");
    linkRoot = path.join(base, "link");
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, "f.txt"), "hello");
    try {
      await fs.symlink(real, linkRoot, "junction");
      ok = true;
    } catch {
      ok = false;
    }
  });
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  // e.g. macOS: os.tmpdir() is under /var, which is a symlink to /private/var, and the
  // default roots are not realpath'd by loadConfig.
  it("allows reading a file inside a root that is a symlink/junction", async (ctx) => {
    if (!ok) ctx.skip();
    await expect(resolveReadable(path.join(linkRoot, "f.txt"), [linkRoot])).resolves.toBeTruthy();
  });

  it("allows writing a file inside a root that is a symlink/junction", async (ctx) => {
    if (!ok) ctx.skip();
    await expect(resolveWritable(path.join(linkRoot, "g.txt"), [linkRoot], false)).resolves.toBeTruthy();
  });
});

describe("8.3 short-name roots on Windows", () => {
  let base: string;
  let longDir: string;
  let shortDir: string | undefined;

  beforeAll(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lw-hunt-short-")));
    longDir = path.join(base, "a very long directory name");
    await fs.mkdir(longDir);
    await fs.writeFile(path.join(longDir, "f.txt"), "x");
    if (isWin) {
      try {
        const out = execFileSync("cmd", ["/c", `for %I in ("${longDir}") do @echo %~sI`], { encoding: "utf8" }).trim();
        if (out && out.toLowerCase() !== longDir.toLowerCase() && !out.includes(" ")) shortDir = out;
      } catch {
        shortDir = undefined;
      }
    }
  });
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("allows reading inside a root spelled with its 8.3 short name", async (ctx) => {
    if (!shortDir) ctx.skip();
    await expect(resolveReadable(path.join(longDir, "f.txt"), [shortDir!])).resolves.toBeTruthy();
  });

  it("denies reading outside a root even when the file is spelled with a short name", async (ctx) => {
    if (!shortDir) ctx.skip();
    const other = path.join(base, "other");
    await fs.mkdir(other, { recursive: true });
    await expect(resolveReadable(path.join(shortDir!, "f.txt"), [other])).rejects.toBeInstanceOf(PathDeniedError);
  });
});

describe("hard links (defense in depth)", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeAll(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lw-hunt-hardlink-")));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "victim.txt"), "original");
  });
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  // An overwrite through a hard link modifies a file whose other name lives outside the
  // roots. Hard links can be created without privilege on NTFS and posix.
  it("refuses to overwrite a file that has other hard links", async (ctx) => {
    const link = path.join(root, "hl.txt");
    try {
      await fs.link(path.join(outside, "victim.txt"), link);
    } catch {
      ctx.skip();
    }
    await expect(resolveWritable(link, [root], true)).rejects.toThrow();
  });
});
