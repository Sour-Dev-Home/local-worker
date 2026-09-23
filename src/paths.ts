import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** Input files larger than this are refused (a 32K-token context holds ~110 KB anyway). */
export const MAX_INPUT_FILE_BYTES = 8 * 1024 * 1024;

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Windows and default macOS volumes are case-insensitive, so compare case-folded there.
 * (That's an assumption on darwin: a case-sensitive APFS volume would make the check
 * looser than the filesystem, never stricter than a case-insensitive one.)
 *
 * Folds each code point to upper case, as NTFS compares against its upcase table, but
 * only BMP code points (the upcase table has no entries above U+FFFF) and only when the
 * mapping is 1:1 and stays on the same side of ASCII. JS case mapping is richer than the
 * filesystem's: "K" (KELVIN SIGN) lowercases to ASCII "k", "ß" uppercases to "SS",
 * "ı" to "I". Treating those as equal would let a root spelled with one admit a different
 * directory spelled with the other. Folding never changes a string's length.
 */
function foldCase(s: string, platform: NodeJS.Platform) {
  if (platform !== "win32" && platform !== "darwin") return s;
  let out = "";
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    const u = cp <= 0xffff ? c.toUpperCase() : c;
    const oneToOne = u.length === 1 && c.length === 1 && (cp < 0x80) === (u.charCodeAt(0) < 0x80);
    out += oneToOne ? u : c;
  }
  return out;
}

/**
 * The part of `p` below `root` ("" for the root itself), or null when `p` isn't inside it.
 * resolve() normalizes separators and removes "." / ".." segments, so what's left is a
 * plain prefix comparison. (Not path.win32.relative: it case-folds with toLowerCase
 * internally, which reintroduces the look-alike folding foldCase avoids.)
 */
function pathBelow(p: string, root: string, platform: NodeJS.Platform): string | null {
  const api = pathApi(platform);
  const stripSep = (s: string) => (s.length > 1 && s.endsWith(api.sep) && !/^[A-Za-z]:\\$/.test(s) ? s.slice(0, -1) : s);
  const target = stripSep(api.resolve(p));
  const r = stripSep(api.resolve(root));
  const ft = foldCase(target, platform);
  const fr = foldCase(r, platform);
  if (ft === fr) return "";
  // A child must continue with a separator: "/work2" is not inside "/work", while
  // "/work/..foo" (a child literally named "..foo") is.
  const prefix = fr.endsWith(api.sep) ? fr : fr + api.sep;
  return ft.startsWith(prefix) ? target.slice(prefix.length) : null;
}

/**
 * True when `p` is one of `roots` or inside one. Purely lexical: callers resolve
 * symlinks first (see resolveReadable / resolveWritable).
 */
export function isUnderRoot(p: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  return roots.some((root) => pathBelow(p, root, platform) !== null);
}

export class PathDeniedError extends Error {
  constructor(requested: string, roots: readonly string[]) {
    super(`${requested} is outside the allowed roots: ${roots.join(", ")}`);
    this.name = "PathDeniedError";
  }
}

/**
 * Resolves each root to its real path, so a root that is (or sits under) a symlink or
 * junction still matches the realpath'd candidates it's compared with (e.g. macOS's /var
 * → /private/var, or a Windows 8.3 short name). A root that doesn't exist is kept as its
 * resolved path. main.ts does this once at startup; the functions below do it again per
 * call, which is cheap and covers callers that pass raw roots.
 */
export async function canonicalizeRoots(roots: readonly string[]): Promise<string[]> {
  return Promise.all(
    roots.map(async (r) => {
      const abs = path.resolve(r);
      return fs.realpath(abs).catch(() => abs);
    }),
  );
}

/**
 * A path segment as Win32 would open it: "name:stream" addresses `name`, and trailing
 * dots and spaces are dropped, so ".git.", ".git " and ".git::$INDEX_ALLOCATION" all mean
 * ".git". Applied on every platform; on posix it only makes the checks stricter.
 */
function effectiveName(seg: string) {
  return seg.split(":")[0]!.replace(/[. ]+$/, "");
}

/** True when any segment of `p` is a `.git` directory name (either separator, any case). */
function hasGitSegment(p: string) {
  return p.split(/[\\/]/).some((seg) => effectiveName(seg).toLowerCase() === ".git");
}

/**
 * Files that agents or build tools read as instructions or execute. Model output written
 * there would be a persisted prompt injection (a CLAUDE.md or AGENTS.md is loaded into
 * every later session) or a supply-chain change (requirements.txt, CMakeLists.txt), even
 * though the extension is an allowed .md or .txt.
 */
function isInstructionOrBuildFile(base: string) {
  const name = effectiveName(base).toLowerCase();
  return (
    ["claude.md", "claude.local.md", "agents.md", "gemini.md", "cmakelists.txt"].includes(name) ||
    /^(requirements|constraints).*\.txt$/.test(name)
  );
}

/**
 * Name rules for a write destination (`target` is already under a root):
 * - no `.git` segment anywhere;
 * - no segment below the root starting with "." (dot-directories such as .claude, .github,
 *   .vscode, .cursor or .husky hold agent instructions, CI workflows and git hooks; dotfiles
 *   are config). A root that itself sits under a dot-directory is allowed: that was the
 *   operator's explicit choice;
 * - not an instruction or build file (isInstructionOrBuildFile).
 */
function checkWriteName(target: string, shown: string, roots: readonly string[], platform: NodeJS.Platform) {
  if (hasGitSegment(shown) || hasGitSegment(target)) throw new Error(`${shown}: refusing to write inside a .git directory`);
  const cleanUnderSomeRoot = roots.some((root) => {
    const below = pathBelow(target, root, platform);
    return below !== null && below.split(/[\\/]/).every((seg) => !effectiveName(seg).startsWith(".") && !seg.startsWith("."));
  });
  if (!cleanUnderSomeRoot) {
    throw new Error(`${shown}: refusing to write into a dot-directory or dotfile (agent instructions, CI and editor config live there)`);
  }
  if (isInstructionOrBuildFile(path.basename(target))) {
    throw new Error(`${shown}: refusing to write an agent-instruction or build file (model output there would persist as instructions)`);
  }
}

/** Resolves an existing file for reading, following symlinks BEFORE the root check. */
export async function resolveReadable(p: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): Promise<string> {
  if (!p) throw new Error("empty path");
  const real = await fs.realpath(path.resolve(p));
  if (!isUnderRoot(real, await canonicalizeRoots(roots), platform)) throw new PathDeniedError(p, roots);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`${p} is not a regular file`);
  return real;
}

// Not defined on Windows; there the identity check below does the work.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0; // a FIFO swapped in can't block the open

/**
 * Reads a file confined to `roots`, as UTF-8, refusing files over `maxBytes`:
 *
 * 1. resolveReadable (realpath, root check, regular file);
 * 2. open that real path once, O_RDONLY | O_NOFOLLOW | O_NONBLOCK (the last two on POSIX);
 * 3. with the handle open, re-verify: the handle is a regular file, the path still
 *    realpaths to itself under a root, and the handle's dev/ino equal a fresh lstat of the
 *    path. So the handle is the file that sits at the verified in-root path, not something
 *    swapped in between steps 1 and 2 (on Windows, where O_NOFOLLOW doesn't exist, a link
 *    swapped in and back out is caught here too);
 * 4. read from that handle at most maxBytes + 1 bytes, never by name again.
 *
 * Residual: a file that is hard-linked into a root is readable (it IS that file); only
 * someone who can already create links inside the root can arrange that.
 */
export async function readConfinedFile(
  p: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform,
  maxBytes: number = MAX_INPUT_FILE_BYTES,
): Promise<{ real: string; text: string }> {
  const real = await resolveReadable(p, roots, platform);
  const fh = await fs.open(real, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) throw new Error(`${p} is not a regular file`);
    const again = await fs.realpath(real);
    if (again !== real || !isUnderRoot(again, await canonicalizeRoots(roots), platform)) {
      throw new Error(`${p} changed while it was being opened; refusing to read it`);
    }
    const now = await fs.lstat(real, { bigint: true });
    if (now.dev !== st.dev || now.ino !== st.ino) throw new Error(`${p} changed while it was being opened; refusing to read it`);
    const tooBig = () => new Error(`${p} is over ${maxBytes} bytes; input files are limited to ${maxBytes} bytes (8 MiB by default)`);
    if (st.size > BigInt(maxBytes)) throw tooBig();

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) throw tooBig(); // it grew after the size check
    }
    return { real, text: Buffer.concat(chunks, total).toString("utf8") };
  } finally {
    await fh.close();
  }
}

async function lstatOrNull(p: string) {
  return fs.lstat(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
}

/**
 * The checks on an existing destination, shared by resolveWritable and the commit step of
 * safeWriteFile. An existing file's real name is checked too: on Windows an 8.3 alias
 * such as "CLAUDE~1.MD" could otherwise address CLAUDE.local.md.
 */
async function checkDestination(target: string, shown: string, overwrite: boolean, roots: readonly string[], platform: NodeJS.Platform) {
  checkWriteName(target, shown, roots, platform);
  const existing = await lstatOrNull(target);
  if (!existing) return;
  if (existing.isSymbolicLink()) throw new Error(`${shown} is a symbolic link; refusing to write through it`);
  if (!existing.isFile()) throw new Error(`${shown} exists and is not a regular file`);
  checkWriteName(await fs.realpath(target), shown, roots, platform);
  if (!overwrite) throw new Error(`${shown} already exists; pass overwrite: true to replace it`);
  // Another name for the same file may live outside the roots.
  if (existing.nlink > 1) throw new Error(`${shown} has other hard links; refusing to replace it`);
}

/**
 * Resolves a destination for writing. The parent directory must exist and is
 * symlink-resolved before the root check. Refuses to write through a symlink (it could
 * point outside the roots), over a directory, over a file with other hard links, into a
 * `.git` directory or any dot-directory / dotfile below the root, to an agent-instruction
 * or build file (CLAUDE.md, AGENTS.md, requirements.txt, ...), or over any existing file
 * unless `overwrite`.
 *
 * This validates up front so a bad path fails fast; the write itself must go through
 * safeWriteFile, which repeats the checks at commit time.
 */
export async function resolveWritable(
  p: string,
  roots: readonly string[],
  overwrite: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (!p) throw new Error("empty path");
  // "dir/" names a directory; path.resolve would silently strip the separator.
  if (/[\\/]$/.test(p)) throw new Error(`${p} ends with a path separator; expected a file path`);
  const abs = path.resolve(p);
  const base = path.basename(abs);
  if (platform === "win32" && base.includes(":")) throw new Error(`${p}: alternate data streams are not allowed`);
  const dir = await fs.realpath(path.dirname(abs));
  const target = path.join(dir, base);
  const canonical = await canonicalizeRoots(roots);
  if (!isUnderRoot(target, canonical, platform)) throw new PathDeniedError(p, roots);
  // Also rejects "<root>/." and "<root>/sub/..": they resolve to a directory.
  await checkDestination(target, p, overwrite, canonical, platform);
  return target;
}

export interface SafeWriteOptions {
  roots: readonly string[];
  overwrite: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Writes `data` to `target` (a path returned by resolveWritable) without trusting that the
 * filesystem still looks the way it did when the path was validated, which may have been
 * minutes ago (the model runs in between):
 *
 * 1. re-realpath the parent: it must be unchanged (not swapped for a link) and under a root;
 * 2. write the content to a fresh temp file in that directory (O_EXCL, so never through a
 *    planted file or link);
 * 3. immediately before committing, re-check the parent and the destination (name rules,
 *    no symlink, no directory, no extra hard links, and absent unless `overwrite`);
 * 4. commit. Without `overwrite`: copy the temp file to the target with COPYFILE_EXCL,
 *    an O_EXCL create that fails if anything (file, link, directory) exists there, on any
 *    filesystem, so it can never clobber or follow a link. With `overwrite`: rename over
 *    the target, which replaces the directory entry and never writes through a link.
 *    The temp file is always removed (unless it was never ours).
 *
 * Residual window: between the step-3 checks and step 4 (microseconds), a process that
 * can write inside the root could swap the parent for a link. Portable Node has no
 * openat/renameat to close that completely; the window is no longer the model's run time.
 */
export async function safeWriteFile(target: string, data: string | Uint8Array, opts: SafeWriteOptions): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const dir = path.dirname(target);
  const base = path.basename(target);
  const roots = await canonicalizeRoots(opts.roots);

  const checkParent = async () => {
    const real = await fs.realpath(dir);
    if (real !== dir) throw new Error(`${dir} changed (it now resolves to ${real}); refusing to write`);
    if (!isUnderRoot(path.join(real, base), roots, platform)) throw new PathDeniedError(target, opts.roots);
  };

  await checkParent();
  await checkDestination(target, target, opts.overwrite, roots, platform);
  const tmp = path.join(dir, `.${base}.${randomBytes(6).toString("hex")}.tmp`);
  let created = false;
  try {
    // If this open fails with EEXIST the file isn't ours, so `created` stays false and the
    // cleanup below leaves it alone. Any later failure (e.g. ENOSPC mid-write) removes it.
    const fh = await fs.open(tmp, "wx");
    created = true;
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    await checkParent();
    await checkDestination(target, target, opts.overwrite, roots, platform);
    if (opts.overwrite) {
      await fs.rename(tmp, target);
    } else {
      await fs.copyFile(tmp, target, fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "EEXIST") throw new Error(`${target} already exists; pass overwrite: true to replace it`);
        throw err;
      });
    }
  } finally {
    if (created) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
