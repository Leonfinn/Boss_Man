import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, checkPortalUrl, fill, parsePage, portalBlocks, requireSiteUrlOnPages } from "../scripts/build.mjs";
import { checkSite } from "../scripts/check.mjs";

let tmp: string;
let dist: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "site-test-"));
  dist = path.join(tmp, "dist");
  build({ outDir: dist, siteUrl: "", portalUrl: "" });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const read = (file: string) => readFileSync(path.join(dist, file), "utf8");
const edit = (file: string, fn: (html: string) => string) => {
  const f = path.join(dist, file);
  const original = readFileSync(f, "utf8");
  writeFileSync(f, fn(original));
  return () => writeFileSync(f, original);
};
const htmlFiles = () => (readdirSync(dist, { recursive: true }) as string[]).map(String).filter((f) => f.endsWith(".html"));

describe("build", () => {
  it("writes the home page, the 404 page, the guides index and every guide, each with the shared header and footer", () => {
    const files = htmlFiles();
    for (const p of ["index.html", "404.html", "guides/index.html", "guides/install-boss-man.html"]) expect(files).toContain(p);
    for (const f of files) {
      const html = read(f);
      expect(html).toContain('<html lang="en-GB">');
      expect(html).toContain("Skip to the content");
      expect(html).toContain('<nav aria-label="Main" id="main-menu">');
      expect(html).toContain('<footer class="foot dark">');
    }
  });

  it("marks the current page in the menu and links the repo from config", () => {
    expect(read("guides/install-boss-man.html")).toMatch(/<a class="btn small" href="\/guides\/install-boss-man" aria-current="page">Install<\/a>/);
    expect(read("guides/index.html")).toMatch(/<a href="\/guides\/" aria-current="page">Guides<\/a>/);
    expect(read("index.html")).toContain('href="https://github.com/Leonfinn/Boss_Man/issues"');
  });

  it("builds a guide with its list, headings list, previous and next links and a Copy button", () => {
    const html = read("guides/install-boss-man.html");
    expect(html).toContain('<nav class="g-nav" aria-label="Guides">');
    expect(html).toContain('<nav class="g-toc" aria-label="On this page">');
    expect(html).toContain('<a href="/guides/install-boss-man" aria-current="page">Install Boss Man</a>');
    expect(html).toContain('data-copy>Copy</button>');
    expect(html).toContain("&lt;host-ip&gt;"); // placeholders in commands are shown, not swallowed as HTML
    expect(html).toContain('<div class="check">');
  });

  it("builds 'How the work goes' as three time cards in order busy, done, setup, then the away strip", () => {
    const html = read("index.html");
    const section = html.slice(html.indexOf("Give it five minutes or an afternoon"), html.indexOf("Reviews, permissions, models"));
    expect(section).not.toContain("review-marker");
    expect(section.match(/<span class="bar" aria-hidden="true">/g)).toHaveLength(3);
    const order = ["Five minutes", "An hour", "An afternoon", "boss-busy.webp", "boss-done.webp", "boss-setup.webp", "While you're away"].map((s) => section.indexOf(s));
    expect(order.every((n) => n > -1)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(order[3]).toBeLessThan(order[4]);
    expect(order[4]).toBeLessThan(order[5]);
    expect(order[5]).toBeLessThan(order[6]);
    for (const img of section.match(/<img [^>]*>/g) ?? []) expect(img).toMatch(/width="\d+" height="\d+"/);
  });

  it("lists Troubleshooting, then the Glossary, then the FAQ, last in the guides list, and links every glossary term to a real guide section", () => {
    const html = read("guides/index.html");
    const cards = html.indexOf('class="g-cards"'); // the header menu links /faq too, so only look at the guide cards
    const at = (p: string) => html.indexOf(`<a href="${p}">`, cards);
    expect(at("/guides/troubleshooting")).toBeGreaterThan(at("/guides/updates-and-backups"));
    expect(at("/guides/glossary")).toBeGreaterThan(at("/guides/troubleshooting"));
    expect(at("/faq")).toBeGreaterThan(at("/guides/glossary"));
    const glossary = read("guides/glossary.html");
    expect((glossary.match(/<li><strong>/g) ?? []).length).toBeGreaterThanOrEqual(62);
    for (const m of glossary.matchAll(/href="(\/guides\/[a-z0-9-]+)(?:#([^"]+))?"/g)) {
      const page = read(`${m[1].slice(1)}.html`);
      if (m[2]) expect(page, `${m[0]} has no target`).toContain(`id="${m[2]}"`);
    }
    for (const m of read("guides/troubleshooting.html").matchAll(/>From: <a href="(\/guides\/[a-z0-9-]+)/g)) expect(existsSync(path.join(dist, `${m[1].slice(1)}.html`))).toBe(true);
  });

  it("sends the old page addresses to their new homes", () => {
    const redirects = read("_redirects");
    expect(redirects).toContain("/get-started /guides/install-boss-man 301");
    expect(redirects).toContain("/how-it-works /guides/how-boss-man-works 301");
    expect(redirects).toContain("/features / 301");
  });

  it("does not ship an email link, the old early-access button or the old beta line", () => {
    for (const f of htmlFiles()) {
      const html = read(f);
      expect(html).not.toMatch(/mailto:|early access|email us|planned for the beta|come with the beta/i);
    }
  });

  it("carries no owner address: only the documented example IP, no home paths, no real tailnet name", () => {
    for (const f of htmlFiles()) {
      const html = read(f);
      const ips = [...html.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)].map((m) => m[0]);
      expect(ips.filter((ip) => ip !== "192.168.1.20" && ip !== "0.0.0.0"), f).toEqual([]); // 0.0.0.0 only appears in "never 0.0.0.0"
      expect(html, f).not.toMatch(/\/home\/(?!you\b)[a-z]|\/mnt\/|\/Users\//);
      for (const m of html.matchAll(/([\w<>-]+)\.ts\.net/g)) expect(m[1], f).toMatch(/<tailnet>|&lt;tailnet&gt;|^tailnet$/);
    }
  });

  it("adds canonical links and a sitemap only when SITE_URL is set", () => {
    expect(existsSync(path.join(dist, "sitemap.xml"))).toBe(false);
    const withUrl = path.join(tmp, "dist-url");
    build({ outDir: withUrl, siteUrl: "https://example.test/", portalUrl: "" });
    expect(readFileSync(path.join(withUrl, "guides/install-boss-man.html"), "utf8")).toContain('<link rel="canonical" href="https://example.test/guides/install-boss-man">');
    const sitemap = readFileSync(path.join(withUrl, "sitemap.xml"), "utf8");
    expect(sitemap).toContain("<loc>https://example.test/guides/install-boss-man</loc>");
    expect(sitemap).toContain("<loc>https://example.test/guides/</loc>");
    expect(sitemap).not.toContain("404");
    expect(readFileSync(path.join(withUrl, "index.html"), "utf8")).toContain('property="og:image" content="https://example.test/img/og-v2.png"');
    expect(checkSite(withUrl, { siteUrl: "https://example.test" })).toEqual([]);
  });

  it("fails a Cloudflare Pages build without SITE_URL", () => {
    expect(() => requireSiteUrlOnPages({ CF_PAGES: "1" })).toThrow(/SITE_URL/);
    expect(() => requireSiteUrlOnPages({ CF_PAGES: "1", SITE_URL: "https://example.com" })).not.toThrow();
    expect(() => requireSiteUrlOnPages({})).not.toThrow();
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

describe("roadmap portal link", () => {
  it("is left out of the menu, the footer and the home page while no portal address is set", () => {
    for (const f of ["index.html", "guides/install-boss-man.html"]) {
      const html = read(f);
      expect(html).not.toMatch(/class="ext"|Roadmap and feedback|Open the Boss Man roadmap|<!--portal-->/);
    }
  });

  it("shows in the menu, the footer and the home page, in the same tab, once an address is set", () => {
    const out = path.join(tmp, "dist-portal");
    build({ outDir: out, siteUrl: "", portalUrl: "https://roadmap.example.com/p/abc" });
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    expect(html.match(/href="https:\/\/roadmap\.example\.com\/p\/abc"/g)?.length).toBe(3); // menu, home box, footer
    expect(html).toContain("Open the Boss Man roadmap");
    expect(html).not.toContain("target=");
    expect(html).toContain("Roadmap<span class=\"sr\"> and feedback, on our feedback portal</span>");
    expect(checkSite(out)).toEqual([]);
  });

  it("refuses an address that would put a home-network address on the public site", () => {
    expect(checkPortalUrl("")).toBe("");
    expect(checkPortalUrl("https://roadmap.example.com/p/abc")).toBe("https://roadmap.example.com/p/abc");
    for (const bad of ["http://roadmap.example.com", "https://192.168.1.5:3101/portal", "https://10.0.0.2", "https://localhost:3101", "https://nas.local", "https://box.tailnet-name.ts.net", "https://user:pw@example.com", "roadmap", "https://nas"]) {
      expect(() => checkPortalUrl(bad), bad).toThrow(/portal address/);
    }
  });

  it("keeps or drops a marked block", () => {
    expect(portalBlocks("a<!--portal-->b<!--/portal-->c", true)).toBe("abc");
    expect(portalBlocks("a<!--portal-->b<!--/portal-->c", false)).toBe("ac");
  });
});

describe("check", () => {
  it("passes on the real build", () => {
    expect(checkSite(dist)).toEqual([]);
  });

  it("catches a broken internal link and a missing image file", () => {
    const undo = edit("guides/install-boss-man.html", (h) => h.replace('href="/guides/"', 'href="/guidez/"').replace("/img/boss-setup.webp", "/img/none.webp"));
    const undo2 = edit("404.html", (h) => h.replace("/img/boss-stuck.webp", "/img/none.webp"));
    const problems: string[] = checkSite(dist);
    undo();
    undo2();
    expect(problems).toContain('guides/install-boss-man.html: link "/guidez/" does not exist');
    expect(problems).toContain('guides/install-boss-man.html: image "/img/none.webp" does not exist');
    expect(problems).toContain('404.html: image "/img/none.webp" does not exist');
  });

  it("catches a phone picture that points at nothing", () => {
    const undo = edit("index.html", (h) => h.replace('srcset="/img/card-phone.webp"', 'srcset="/img/gone.webp"'));
    const problems: string[] = checkSite(dist);
    undo();
    expect(problems).toContain('index.html: image "/img/gone.webp" does not exist');
  });

  it("catches a missing description, a second h1, a missing alt and a mailto link", () => {
    const undo = edit("404.html", (h) =>
      h.replace(/<meta name="description"[^>]*>/, "").replace("</main>", '<h1>Again</h1><img src="/img/hero.webp" width="1" height="1"><a href="mailto:a@b.c">x</a></main>'),
    );
    const problems: string[] = checkSite(dist);
    undo();
    expect(problems).toContain("404.html: missing meta description");
    expect(problems).toContain("404.html: has 2 h1 headings, expected 1");
    expect(problems).toContain("404.html: image /img/hero.webp has no alt attribute");
    expect(problems.some((p) => p.includes("mailto link"))).toBe(true);
  });

  it("catches an inline style or script, which the Content-Security-Policy would block", () => {
    const undo = edit("404.html", (h) => h.replace("</main>", '<p style="color:red">x</p><script>alert(1)</script></main>'));
    const problems: string[] = checkSite(dist);
    undo();
    expect(problems).toContain("404.html: inline style (the Content-Security-Policy blocks it)");
    expect(problems).toContain("404.html: inline script (the Content-Security-Policy blocks it)");
  });

  it("catches a heading level that is skipped", () => {
    const undo = edit("404.html", (h) => h.replace("</main>", "<h4>Skipped</h4></main>"));
    const problems: string[] = checkSite(dist);
    undo();
    expect(problems).toContain("404.html: heading jumps from h1 to h4");
  });

  it("catches a missing lang attribute", () => {
    const undo = edit("index.html", (h) => h.replace(' lang="en-GB"', ""));
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
