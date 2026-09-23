import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isUnderRoot, PathDeniedError, resolveReadable, resolveWritable } from "../src/paths.js";

describe("isUnderRoot (lexical)", () => {
  it("accepts the root itself and its children (posix)", () => {
    expect(isUnderRoot("/work", ["/work"], "linux")).toBe(true);
    expect(isUnderRoot("/work/a/b.txt", ["/work"], "linux")).toBe(true);
  });

  it("rejects parents, siblings sharing a prefix, and traversal (posix)", () => {
    expect(isUnderRoot("/", ["/work"], "linux")).toBe(false);
    expect(isUnderRoot("/work2/x", ["/work"], "linux")).toBe(false);
    expect(isUnderRoot("/work/../etc/passwd", ["/work"], "linux")).toBe(false);
  });

  it("allows a child whose name merely starts with '..'", () => {
    expect(isUnderRoot("/work/..hidden/file", ["/work"], "linux")).toBe(true);
    expect(isUnderRoot("C:\\work\\..hidden\\file", ["C:\\work"], "win32")).toBe(true);
  });

  it("is case-sensitive on linux, case-insensitive on win32", () => {
    expect(isUnderRoot("/Work/x", ["/work"], "linux")).toBe(false);
    expect(isUnderRoot("c:\\WORK\\x", ["C:\\work"], "win32")).toBe(true);
  });

  it("rejects a different drive and UNC paths on win32", () => {
    expect(isUnderRoot("D:\\work\\x", ["C:\\work"], "win32")).toBe(false);
    expect(isUnderRoot("\\\\server\\share\\x", ["C:\\work"], "win32")).toBe(false);
  });

  it("checks every root", () => {
    expect(isUnderRoot("/tmp/x", ["/work", "/tmp"], "linux")).toBe(true);
  });
});

describe("resolveReadable / resolveWritable (real filesystem)", () => {
  let base: string; // realpath'd temp dir
  let root: string;
  let outside: string;

  beforeAll(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lw-paths-")));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    await fs.mkdir(path.join(root, "sub"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(root, "in.txt"), "inside");
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  });
  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("reads a file inside the root", async () => {
    await expect(resolveReadable(path.join(root, "in.txt"), [root])).resolves.toBe(path.join(root, "in.txt"));
  });

  it("denies a file outside the root, including via '..'", async () => {
    await expect(resolveReadable(path.join(outside, "secret.txt"), [root])).rejects.toBeInstanceOf(PathDeniedError);
    await expect(resolveReadable(path.join(root, "sub", "..", "..", "outside", "secret.txt"), [root])).rejects.toBeInstanceOf(PathDeniedError);
  });

  it("rejects directories and missing files", async () => {
    await expect(resolveReadable(path.join(root, "sub"), [root])).rejects.toThrow(/not a regular file/);
    await expect(resolveReadable(path.join(root, "nope.txt"), [root])).rejects.toThrow();
  });

  it("denies reading through a symlink that points outside the root", async (ctx) => {
    const link = path.join(root, "escape.txt");
    try {
      await fs.symlink(path.join(outside, "secret.txt"), link);
    } catch {
      ctx.skip(); // creating symlinks needs extra privileges on some Windows setups
    }
    await expect(resolveReadable(link, [root])).rejects.toBeInstanceOf(PathDeniedError);
  });

  it("allows a new file inside the root and denies one outside", async () => {
    await expect(resolveWritable(path.join(root, "new.txt"), [root], false)).resolves.toBe(path.join(root, "new.txt"));
    await expect(resolveWritable(path.join(outside, "new.txt"), [root], false)).rejects.toBeInstanceOf(PathDeniedError);
  });

  it("refuses to replace an existing file unless overwrite is set", async () => {
    await expect(resolveWritable(path.join(root, "in.txt"), [root], false)).rejects.toThrow(/already exists/);
    await expect(resolveWritable(path.join(root, "in.txt"), [root], true)).resolves.toBe(path.join(root, "in.txt"));
  });

  it("refuses to write over a directory", async () => {
    await expect(resolveWritable(path.join(root, "sub"), [root], true)).rejects.toThrow(/not a regular file/);
  });

  it("refuses to write through a symlink even with overwrite", async (ctx) => {
    const link = path.join(root, "out-link.txt");
    try {
      await fs.symlink(path.join(outside, "secret.txt"), link);
    } catch {
      ctx.skip();
    }
    await expect(resolveWritable(link, [root], true)).rejects.toThrow(/symbolic link/);
  });

  it("fails when the parent directory doesn't exist", async () => {
    await expect(resolveWritable(path.join(root, "missing-dir", "x.txt"), [root], false)).rejects.toThrow();
  });
});
