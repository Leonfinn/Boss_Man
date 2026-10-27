import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, fill, parsePage } from "../scripts/build.mjs";
import { checkSite } from "../scripts/check.mjs";

let tmp: string;
let dist: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "site-test-"));
  dist = path.join(tmp, "dist");
  build({ outDir: dist, siteUrl: "" });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const edit = (file: string, fn: (html: string) => string) => {
  const f = path.join(dist, file);
  const original = readFileSync(f, "utf8");
  writeFileSync(f, fn(original));
  return () => writeFileSync(f, original);
};

describe("build", () => {
  it("writes all six pages and the shared header and footer", () => {
    for (const p of ["index", "features", "how-it-works", "get-started", "faq", "404"]) {
      const html = readFileSync(path.join(dist, `${p}.html`), "utf8");
      expect(html).toContain('<html lang="en">');
      expect(html).toContain("Skip to content");
      expect(html).toContain("Code on GitHub");
    }
  });

  it("marks the current page in the nav and links the repo once from config", () => {
    const html = readFileSync(path.join(dist, "faq.html"), "utf8");
    expect(html).toMatch(/<a href="\/faq" aria-current="page">FAQ<\/a>/);
    expect(html).toContain('href="https://github.com/Leonfinn/Boss_Man/issues"');
  });

  it("does not ship an email link or the old early-access button", () => {
    for (const p of ["index", "features", "get-started", "faq"]) {
      const html = readFileSync(path.join(dist, `${p}.html`), "utf8");
      expect(html).not.toMatch(/mailto:|early access|email us/i);
    }
  });

  it("adds canonical links and a sitemap only when SITE_URL is set", () => {
    expect(existsSync(path.join(dist, "sitemap.xml"))).toBe(false);
    const withUrl = path.join(tmp, "dist-url");
    build({ outDir: withUrl, siteUrl: "https://example.test/" });
    expect(readFileSync(path.join(withUrl, "features.html"), "utf8")).toContain('<link rel="canonical" href="https://example.test/features">');
    const sitemap = readFileSync(path.join(withUrl, "sitemap.xml"), "utf8");
    expect(sitemap).toContain("<loc>https://example.test/how-it-works</loc>");
    expect(sitemap).not.toContain("404");
    expect(readFileSync(path.join(withUrl, "index.html"), "utf8")).toContain('property="og:image" content="https://example.test/img/og.png"');
    expect(checkSite(withUrl, { siteUrl: "https://example.test" })).toEqual([]);
  });

  it("rejects a SITE_URL that is not a bare https origin", () => {
    const out = path.join(tmpdir(), "site-bad-url");
    for (const bad of ["example.com", "http://example.com", "https://example.com/docs", "https://exa mple.com"]) {
      expect(() => build({ outDir: out, siteUrl: bad })).toThrow(/SITE_URL/);
    }
    rmSync(out, { recursive: true, force: true });
  });

  it("fails on an unknown placeholder or a page without a description", () => {
    expect(() => fill("{{nope}}", { repo: "x" }, "t.html")).toThrow(/unknown placeholder/);
    expect(() => parsePage("---\ntitle: A\npath: /a\n---\n<h1>A</h1>", "a.html")).toThrow(/description/);
  });
});

describe("check", () => {
  it("passes on the real build", () => {
    expect(checkSite(dist)).toEqual([]);
  });

  it("catches a broken internal link and a missing image file", () => {
    const undo = edit("faq.html", (h) => h.replace('href="/get-started"', 'href="/get-starteed"').replace("/img/boss-stuck.webp", "/img/none.webp"));
    const undo2 = edit("404.html", (h) => h.replace("/img/boss-stuck.webp", "/img/none.webp"));
    const problems: string[] = checkSite(dist);
    undo();
    undo2();
    expect(problems).toContain('faq.html: link "/get-starteed" does not exist');
    expect(problems).toContain('404.html: image "/img/none.webp" does not exist');
  });

  it("catches a missing description, a second h1, a missing alt and a mailto link", () => {
    const undo = edit("features.html", (h) =>
      h.replace(/<meta name="description"[^>]*>/, "").replace("</main>", '<h1>Again</h1><img src="/img/hero.webp" width="1" height="1"><a href="mailto:a@b.c">x</a></main>'),
    );
    const problems: string[] = checkSite(dist);
    undo();
    expect(problems).toContain("features.html: missing meta description");
    expect(problems).toContain("features.html: has 2 h1 headings, expected 1");
    expect(problems).toContain("features.html: image /img/hero.webp has no alt attribute");
    expect(problems.some((p) => p.includes("mailto link"))).toBe(true);
  });

  it("catches a missing lang attribute", () => {
    const undo = edit("index.html", (h) => h.replace(' lang="en"', ""));
    const problems: string[] = checkSite(dist);
    undo();
    expect(problems).toContain("index.html: <html> has no lang attribute");
  });

  it("catches an icon url() in the stylesheet that points at nothing", () => {
    const undo = edit("styles.css", (c) => c + '\n.x { background: url("/img/gone.webp"); }');
    const problems: string[] = checkSite(dist);
    undo();
    expect(problems).toContain('styles.css: url() "/img/gone.webp" does not exist');
  });
});
