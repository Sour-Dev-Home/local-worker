import { describe, expect, it } from "vitest";
import { browserArgs, markdownToHtml, PDF_CSP } from "../src/pdf.js";

const bodyOf = (html: string) => html.slice(html.indexOf("<body>"));

describe("PDF_CSP", () => {
  it("allows only inline styles and data: images (no file:, no network)", () => {
    expect(PDF_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(PDF_CSP).not.toContain("file:");
  });

  it("is embedded in the generated document", () => {
    expect(markdownToHtml("x", "t")).toContain(`<meta http-equiv="Content-Security-Policy" content="${PDF_CSP}">`);
  });
});

describe("markdownToHtml: raw HTML renders as visible text", () => {
  it("escapes a block <script>", () => {
    const body = bodyOf(markdownToHtml("# T\n\n<script>alert(1)</script>\n", "t"));
    expect(body).not.toMatch(/<script/i);
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a raw <img> pointing at a local file, inline and as a block", () => {
    const inline = bodyOf(markdownToHtml('See <img src="file:///etc/passwd"> here.', "t"));
    expect(inline).not.toMatch(/<img/i);
    expect(inline).toContain("&lt;img src=&quot;file:///etc/passwd&quot;&gt;");
    const block = bodyOf(markdownToHtml('<img src="file://host/share/x.png">\n', "t"));
    expect(block).not.toMatch(/<img/i);
  });

  it("escapes a <meta http-equiv=refresh> in the body", () => {
    const body = bodyOf(markdownToHtml('<meta http-equiv="refresh" content="0;url=https://example.com">\n', "t"));
    expect(body).not.toMatch(/<meta/i);
    expect(body).toContain("&lt;meta");
  });

  it("still renders ordinary markdown", () => {
    const body = bodyOf(markdownToHtml("# Title\n\n**bold** and `code`\n\n```\n<b>in a code block</b>\n```\n", "t"));
    expect(body).toContain("<h1>Title</h1>");
    expect(body).toContain("<strong>bold</strong>");
    expect(body).toContain("&lt;b&gt;in a code block&lt;/b&gt;");
  });
});

describe("browserArgs", () => {
  it("blocks DNS resolution as defense in depth and prints to the given path", () => {
    const args = browserArgs("tmpdir", "doc.html", "out.pdf");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
    expect(args).toContain("--headless");
    expect(args).toContain("--print-to-pdf=out.pdf");
  });
});
