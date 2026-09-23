import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Marked } from "marked";

const STYLE = `
  @page { margin: 18mm 16mm; }
  body { font: 11pt/1.5 "Segoe UI", system-ui, sans-serif; color: #1a1a1a; }
  h1, h2, h3 { line-height: 1.25; margin: 1.2em 0 .4em; } h1 { font-size: 20pt; }
  h2 { font-size: 15pt; border-bottom: 1px solid #ddd; padding-bottom: .2em; }
  code { font: 9.5pt Consolas, monospace; background: #f3f3f3; padding: 0 .25em; border-radius: 3px; }
  pre { background: #f6f6f6; padding: .8em; border-radius: 4px; white-space: pre-wrap; } pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: .3em .5em; text-align: left; } th { background: #f0f0f0; }
  blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #555; }`;

export function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Blocks scripts, frames, forms and every fetch in the rendered document; only the inline
 * stylesheet and data: images load. No `file:`: it would let crafted markdown embed any
 * local image the browser can read, and on Windows `file://host/...` makes an SMB request
 * (leaking NTLM credentials). Done in the document itself rather than with a browser flag:
 * `--blink-settings=scriptEnabled=false` makes headless Edge silently skip --print-to-pdf
 * (exit 0, no file).
 */
export const PDF_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/**
 * A private instance (never the global `marked`, whose options other code could change)
 * that renders raw HTML, block or inline, as visible escaped text. So `<script>`,
 * `<img>` and `<meta http-equiv=refresh>` in the markdown never become elements; PDF_CSP
 * is the second layer, for what markdown itself generates (e.g. `![](file:///x)` images).
 */
const md = new Marked({
  async: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

/** Markdown → a standalone HTML document, with raw HTML escaped (see `md`). */
export function markdownToHtml(markdown: string, title: string): string {
  const body = md.parse(markdown, { async: false });
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
  );
}

export async function findBrowser(candidates: readonly string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await fs.stat(c).then((s) => s.isFile(), () => false)) return c;
  }
  return null;
}

/** Command line for a headless print of `htmlPath` to `outputPath`, with a throwaway profile in `tmpDir`. */
export function browserArgs(tmpDir: string, htmlPath: string, outputPath: string): string[] {
  return [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    // Defense in depth behind PDF_CSP: no hostname resolves, so nothing can phone home.
    "--host-resolver-rules=MAP * ~NOTFOUND",
    `--user-data-dir=${path.join(tmpDir, "profile")}`,
    `--print-to-pdf=${outputPath}`,
    pathToFileURL(htmlPath).href,
  ];
}

/** Prints an HTML document to PDF with a headless Chromium-based browser. */
export async function printHtmlToPdf(html: string, outputPath: string, browser: string, timeoutMs = 60_000): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-worker-"));
  const htmlPath = path.join(tmpDir, "doc.html");
  await fs.writeFile(htmlPath, html, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(browser, browserArgs(tmpDir, htmlPath, outputPath), { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`browser timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`browser exited with code ${code}`));
      });
    });
    const stat = await fs.stat(outputPath).catch(() => null);
    if (!stat || stat.size === 0) throw new Error("browser finished but produced no PDF");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
