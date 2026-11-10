import { describe, expect, it } from "vitest";
import { renderMarkdown, slugify } from "../scripts/markdown.mjs";

const render = (md: string) => renderMarkdown(md, { name: "t.md", repo: "https://github.com/o/r" });

describe("guide Markdown", () => {
  it("makes headings with ids, lists the h2s, and keeps ids unique", () => {
    const { html, headings } = render("## 1. Choose a folder\n\n### A sub-step\n\n## 1. Choose a folder\n");
    expect(html).toContain('<h2 id="1-choose-a-folder">1. Choose a folder</h2>');
    expect(html).toContain('<h3 id="a-sub-step">A sub-step</h3>');
    expect(html).toContain('<h2 id="1-choose-a-folder-2">');
    expect(headings.map((h) => h.id)).toEqual(["1-choose-a-folder", "1-choose-a-folder-2"]);
    expect(slugify("Mac & Windows!")).toBe("mac-windows");
  });

  it("escapes angle brackets and never formats inside code", () => {
    const { html } = render("Use `<host-ip>` and `**not bold**` then **bold** and *soft*.\n\n```sh Run it\necho \"<x>\" && a=*b*\n```\n");
    expect(html).toContain("<code>&lt;host-ip&gt;</code>");
    expect(html).toContain("<code>**not bold**</code>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>soft</em>");
    expect(html).toContain('<p class="g-code-label">Run it</p>');
    expect(html).toContain("echo &quot;&lt;x&gt;&quot; &amp;&amp; a=*b*");
    expect(html).toContain("data-copy");
  });

  it("builds lists, one nested level, and joins wrapped lines", () => {
    const { html } = render("- one\n  still one\n- two\n  - inner\n\n1. first\n2. second\n");
    expect(html).toContain('<ul class="g-list"><li>one still one</li><li>two<ul class="g-list"><li>inner</li></ul></li></ul>');
    expect(html).toContain('<ol class="g-steps"><li>first</li><li>second</li></ol>');
  });

  it("builds notes, worked boxes, tables and figures", () => {
    const { html } = render(
      ":::note Before you start\nThe runner says **Connected**.\n:::\n\n:::worked\nIt prints a line.\n:::\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![Alt text](/img/a.svg =100x50 narrow=/img/a-narrow.svg:40x90 \"Caption\")\n",
    );
    expect(html).toContain('<aside class="note"><h2>Before you start</h2>');
    expect(html).toContain('<span class="tick" aria-hidden="true">✓</span>');
    expect(html).toContain('<th scope="col">A</th>');
    expect(html).toContain('<td>2</td>');
    expect(html).toContain('<source media="(max-width: 900px)" srcset="/img/a-narrow.svg" width="40" height="90">');
    expect(html).toContain('<img src="/img/a.svg" width="100" height="50" alt="Alt text" loading="lazy">');
    expect(html).toContain("<figcaption>Caption</figcaption>");
  });

  it("turns @repo into the repository address and refuses other link kinds", () => {
    expect(render("[docs](@repo/blob/main/x.md)").html).toContain('href="https://github.com/o/r/blob/main/x.md"');
    expect(render("[a](/guides/x) [b](#top) [c](https://example.com/p?a=1&b=2)").html).toContain("a=1&amp;b=2");
    for (const bad of ["javascript:alert(1)", "mailto:a@b.c", "http://example.com", "//evil.test/x", "page.html"]) {
      expect(() => render(`[x](${bad})`), bad).toThrow(/not allowed/);
    }
  });

  it("fails on a table with the wrong cell count, an image without a size or alt, an unclosed block and a stray h1", () => {
    expect(() => render("| A | B |\n|---|---|\n| 1 |\n")).toThrow(/expected 2/);
    expect(() => render("![alt](/img/a.webp)")).toThrow(/needs the form|needs the form/);
    expect(() => render("![](/img/a.webp =1x1)")).toThrow(/needs alt text/);
    expect(() => render("```sh\necho hi\n")).toThrow(/never closed/);
    expect(() => render(":::note\nhi\n")).toThrow(/never closed/);
    expect(() => render(":::weird\nhi\n:::\n")).toThrow(/unknown box/);
    expect(() => render("# Title\n")).toThrow(/use ## or ###/);
  });
});
