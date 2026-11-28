import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, checkPortalUrl, checkUmami, fill, parsePage, portalBlocks, readChangelog, requireSiteUrlOnPages } from "../scripts/build.mjs";
import { checkSite, xmlProblem } from "../scripts/check.mjs";

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
      // 0.0.0.0 is the "listen everywhere" setting; 127.0.0.1 is loopback (Paperclip's built-in database in the
      // Paperclip guide), so neither can be an owner's address.
      expect(ips.filter((ip) => ip !== "192.168.1.20" && ip !== "0.0.0.0" && ip !== "127.0.0.1"), f).toEqual([]);
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

  it("writes an Atom feed of the changelog, newest first, only when SITE_URL is set", () => {
    expect(existsSync(path.join(dist, "whats-new.xml"))).toBe(false);
    expect(read("index.html")).not.toContain("whats-new.xml");
    expect(read("whats-new.html")).not.toContain("Follow by feed");
    const withUrl = path.join(tmp, "dist-feed");
    build({ outDir: withUrl, siteUrl: "https://example.test", portalUrl: "" });
    const feed = readFileSync(path.join(withUrl, "whats-new.xml"), "utf8");
    const source = readFileSync(path.join(__dirname, "..", "..", "..", "CHANGELOG.md"), "utf8");
    const first = /^## (.+)$/m.exec(source)![1];
    const id = first.toLowerCase().replace(/ /g, "-");
    expect(xmlProblem(feed)).toBe("");
    expect(feed).toContain(`<id>https://example.test/whats-new#${id}</id>`);
    expect(feed).toContain(`<title>${first}</title>`);
    const [day, month, year] = first.split(" ");
    const iso = new Date(Date.UTC(+year, ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].indexOf(month), +day)).toISOString().replace(".000Z", "Z");
    expect(feed).toMatch(new RegExp(`</title>\\s*<updated>${iso}</updated>\\s*<content type="html">&lt;`));
    expect(feed.match(/<updated>/g)!.length).toBeLessThanOrEqual(21);
    expect(feed.indexOf(`<updated>${iso}</updated>`)).toBeLessThan(feed.indexOf("<entry>"));
    const head = '<link rel="alternate" type="application/atom+xml" title="Boss Man: What\'s new" href="/whats-new.xml">';
    for (const f of ["index.html", "404.html", "whats-new.html", "guides/index.html"]) expect(readFileSync(path.join(withUrl, f), "utf8"), f).toContain(head);
    expect(readFileSync(path.join(withUrl, "whats-new.html"), "utf8")).toContain('<a href="/whats-new.xml">Follow by feed</a>');
    expect(checkSite(withUrl, { siteUrl: "https://example.test" })).toEqual([]);
  });

  it("caps the feed at 20 entries", () => {
    const f = path.join(tmp, "long-changelog.md");
    const days = Array.from({ length: 25 }, (_, i) => `## ${25 - i} October 2026\n\n**In image 0.1.0-beta.1**\n\n- Change ${i}\n`).join("\n");
    writeFileSync(f, `# Title\n\n${days}`);
    const out = path.join(tmp, "dist-long");
    build({ outDir: out, siteUrl: "https://example.test", portalUrl: "", changelogFile: f });
    const feed = readFileSync(path.join(out, "whats-new.xml"), "utf8");
    expect(feed.match(/<entry>/g)).toHaveLength(20);
    expect(feed).toContain("<updated>2026-10-25T00:00:00Z</updated>\n  <entry>");
    expect(feed).not.toContain("<title>5 October 2026</title>");
  });

  it("the site check fails when the feed is missing or not well-formed", () => {
    const withUrl = path.join(tmp, "dist-feed-check");
    build({ outDir: withUrl, siteUrl: "https://example.test", portalUrl: "" });
    const file = path.join(withUrl, "whats-new.xml");
    const good = readFileSync(file, "utf8");
    writeFileSync(file, good.replace("</feed>", ""));
    expect(checkSite(withUrl, { siteUrl: "https://example.test" }).join("\n")).toMatch(/whats-new\.xml is not well-formed XML/);
    writeFileSync(file, good.replace("<title>Boss Man", "<title>Boss & Man"));
    expect(checkSite(withUrl, { siteUrl: "https://example.test" }).join("\n")).toMatch(/bare &/);
    rmSync(file);
    expect(checkSite(withUrl, { siteUrl: "https://example.test" })).toContain("whats-new.xml is missing");
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

describe("About page", () => {
  it("builds /about in its own head, with the owner's words as they were approved", () => {
    const html = read("about.html");
    expect(html).toContain('<section class="about-head dark">');
    expect(html).toContain("<h1>About me</h1>");
    expect(html).toContain("I'm a product manager, and I've worked on some of England's largest IT systems");
    expect(html).toContain('<p class="byline">Leon Finnerty</p>');
    expect(html).toContain('<h2 id="story-h">Why I built Boss Man</h2>');
    expect(html).toContain("<h3>What Boss Man does differently</h3>");
    expect((html.match(/<li>/g) ?? []).length).toBeGreaterThanOrEqual(5); // the 5-item feature list, plus the one footer item
    expect(html).toContain('id="short-h">Boss Man in short');
    expect(html).not.toMatch(/slot-tag|photo-slot|placeholder|pull|Where it's going/i); // the owner left those blank
  });

  it("puts the owner's photo in the 4:5 frame with the given alt, width and height", () => {
    expect(read("about.html")).toMatch(/<img class="photo" src="\/img\/owner\.webp" width="725" height="900" alt="Leon Finnerty, smiling, on a clifftop above the sea\.">/);
  });

  it("ships an optimised WebP with no EXIF or location data", () => {
    const webp = readFileSync(path.join(dist, "img/owner.webp"));
    expect(webp.toString("ascii", 0, 4)).toBe("RIFF");
    expect(webp.toString("ascii", 8, 12)).toBe("WEBP");
    expect(webp.length).toBeLessThan(100_000);
    const text = webp.toString("latin1");
    for (const tag of ["EXIF", "GPS", "XMP"]) expect(text).not.toContain(tag);
  });

  it("links About from the header, the phone menu and the footer on every page, marked current on About", () => {
    for (const f of htmlFiles()) {
      const html = read(f);
      const footer = html.slice(html.indexOf('<nav aria-label="Footer">'));
      expect(html, f).toMatch(/<a href="\/about" aria-current="page">About<\/a>|<a href="\/about">About<\/a>/);
      expect(footer, f).toContain('<a href="/about">About</a>');
    }
    expect(read("about.html")).toContain('<a href="/about" aria-current="page">About</a>');
    expect(read("index.html")).not.toContain('href="/about" aria-current');
  });
});

describe("What's new page", () => {
  const changelog = (text: string) => {
    const f = path.join(tmp, "CHANGELOG-test.md");
    writeFileSync(f, text);
    return () => readChangelog(f);
  };

  it("builds /whats-new from the repo's CHANGELOG.md, newest entry first, without the file's preamble or the release-step comment", () => {
    const html = read("whats-new.html");
    const source = readFileSync(path.join(__dirname, "..", "..", "..", "CHANGELOG.md"), "utf8");
    const first = /^## (.+)$/m.exec(source)![1];
    expect(html).toContain("<h1>What's new</h1>");
    expect(html).toContain(`<h2 id="${first.toLowerCase().replace(/ /g, "-")}">${first}</h2>`);
    expect(html).toContain(`Latest entry: ${first}.`);
    expect(html).not.toContain("# What's new in Boss Man");
    expect(html).not.toMatch(/release step|<!--/i);
    expect(html).toContain('href="/guides/updates-and-backups"');
  });

  it("is linked from the main menu and the footer of every page, marked current on its own page, and from the updating guide", () => {
    for (const f of htmlFiles()) {
      const html = read(f);
      const menu = html.slice(html.indexOf('<nav aria-label="Main"'), html.indexOf("</nav>"));
      const footer = html.slice(html.indexOf('<nav aria-label="Footer">'));
      expect(menu, f).toMatch(/<a href="\/whats-new"( aria-current="page")?>What's new<\/a>/);
      expect(footer, f).toContain('<a href="/whats-new">What\'s new</a>');
    }
    expect(read("whats-new.html")).toContain('<a href="/whats-new" aria-current="page">What\'s new</a>');
    expect(read("index.html")).not.toContain('href="/whats-new" aria-current');
    expect(read("guides/updates-and-backups.html")).toContain('href="/whats-new"');
  });

  it("carries no ticket number, host address or home path on the built page", () => {
    const html = read("whats-new.html");
    expect(html).not.toMatch(/\bBOS-\d+/i);
    expect(html).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\.ts\.net|\/mnt\/|\/home\//);
  });

  it("stops the build on an entry that is not a date, dates out of order or repeated, a ticket number, or no entries", () => {
    const ok = "# What's new\n\nIntro.\n\n## 16 November 2026\n\n**In image 0.1.0-beta.1**\n\n- A change.\n\n## 2 November 2026\n\n**In image 0.1.0-beta.1**\n\n- Another.\n";
    expect(changelog(ok)().dates).toEqual(["16 November 2026", "2 November 2026"]);
    expect(changelog(ok.replace("16 November", "Week 46"))).toThrow(/is not a date/);
    expect(changelog(ok.replace("16 November", "31 November"))).toThrow(/is not a date/);
    expect(changelog(ok.replace("16 November", "16 Nov"))).toThrow(/is not a date/);
    expect(changelog(ok.replace("16 November", "1 November"))).toThrow(/out of order/);
    expect(changelog(ok.replace("16 November", "2 November"))).toThrow(/out of order/);
    expect(changelog(ok.replace("A change.", "A change (BOS-1658)."))).toThrow(/ticket number/);
    expect(changelog("# What's new\n\nNothing yet.\n")).toThrow(/no entries/);
  });

  it("accepts the two image label shapes under a date, and a split day's second label before its older lines", () => {
    const page = (date: string, label: string, body = "- A change.") => `# What's new\n\n## ${date}\n\n${label}\n\n${body}\n`;
    const read = (text: string) => changelog(text)();

    const inImage = read(page("16 November 2026", "**In image 0.1.0-beta.4**"));
    expect(inImage.dates).toEqual(["16 November 2026"]);
    expect(inImage.sections[0].labels).toEqual([{ index: 2, kind: "in", version: "0.1.0-beta.4", line: "**In image 0.1.0-beta.4**" }]);

    const notImage = read(page("16 November 2026", "**Not in an image yet:** comes with the next weekly image (Tuesdays)."));
    expect(notImage.sections[0].labels[0]).toMatchObject({ kind: "not", note: "comes with the next weekly image (Tuesdays)." });

    const split = read(page("1 December 2026", "**Not in an image yet:** comes with the next weekly image (Tuesdays).", "- A later change.\n\n**In image 0.1.0-beta.4**\n\n- An older change."));
    expect(split.sections[0].labels.map((l) => l.kind)).toEqual(["not", "in"]);

    // After the release relabels the top of a split day, both labels are "In image", each with its own version.
    const releasedSplit = read(page("1 December 2026", "**In image 0.1.0-beta.5**", "- A newer change.\n\n**In image 0.1.0-beta.4**\n\n- An older change."));
    expect(releasedSplit.sections[0].labels.map((l) => l.version)).toEqual(["0.1.0-beta.5", "0.1.0-beta.4"]);
  });

  it("refuses a date with no label, an unknown label shape, a second label of the same kind, or a not-yet label below an in-image one, naming the date", () => {
    const page = (text: string) => `# What's new\n\n${text}\n`;
    const read = (text: string) => changelog(text);

    expect(read(page("## 16 November 2026\n\n- A change.\n"))).toThrow(/16 November 2026.*no image label line/);
    expect(read(page("## 16 November 2026\n\n**In image beta.4**\n\n- A change.\n"))).toThrow(/16 November 2026.*unknown image label line/);
    expect(read(page("## 16 November 2026\n\n**Coming soon**\n\n- A change.\n"))).toThrow(/16 November 2026.*unknown image label line/);
    // A second "Not in an image yet" is one not-yet label too many.
    expect(read(page("## 16 November 2026\n\n**Not in an image yet:** first.\n\n- A change.\n\n**Not in an image yet:** second.\n\n- Another.\n"))).toThrow(/16 November 2026/);
    // Two labels with nothing between them are not a split day.
    expect(read(page("## 16 November 2026\n\n**In image 0.1.0-beta.4**\n\n**In image 0.1.0-beta.3**\n\n- A change.\n"))).toThrow(/16 November 2026.*nothing between/);
    // A not-yet date below an in-image date is out of order, whether on another date or on the same split day.
    expect(read(page("## 16 November 2026\n\n**In image 0.1.0-beta.4**\n\n- A change.\n\n## 15 November 2026\n\n**Not in an image yet:** later.\n\n- Another.\n"))).toThrow(/15 November 2026.*below an "In image" one/);
    expect(read(page("## 16 November 2026\n\n**In image 0.1.0-beta.4**\n\n- A change.\n\n**Not in an image yet:** later.\n\n- Another.\n"))).toThrow(/16 November 2026.*below an "In image" one/);
    // The label must be the first thing under the heading.
    expect(read(page("## 16 November 2026\n\n- A change.\n\n**Not in an image yet:** comes next.\n"))).toThrow(/16 November 2026/);
  });

  it("shows each label as a badge, links an in-image badge to its GitHub release, and keeps the note beside the not-yet badge", () => {
    const html = read("whats-new.html");
    expect(html).toContain('<a class="wn-badge in" href="https://github.com/Leonfinn/Boss_Man/releases/tag/v0.1.0-beta.3">');
    expect(html).toContain("In image 0.1.0-beta.3");
    expect(html).toContain('<span class="wn-badge not">');
    expect(html).toContain("Not in an image yet</span> <span class=\"wn-badge-note\">comes with the next weekly image (Tuesdays).</span>");
    expect(html).not.toContain("<strong>In image");
    expect(html).not.toContain("<strong>Not in an image yet");
    const rows = (html.match(/class="wn-badge-row/g) ?? []).length;
    const labels = (html.match(/In image 0\.1\.0-beta/g) ?? []).length + (html.match(/Not in an image yet<\/span>/g) ?? []).length;
    expect(rows).toBe(labels);
  });

  it("has the source-vs-image explainer box under the lead, with both panels and the Which do I have pointer", () => {
    const html = read("whats-new.html");
    expect(html).toContain('<aside class="wn-how" aria-labelledby="wn-how-h">');
    expect(html).toContain('<h2 id="wn-how-h">When you get each change</h2>');
    expect(html).toContain("Built from source");
    expect(html).toContain("You get each change as soon as it is added. Update your server to pick it up.");
    expect(html).toContain("Ready-made Docker image");
    expect(html).toContain("A new image comes out once a week, on Tuesdays, with every change up to then. A newer change waits for the next image.");
    expect(html).toContain("Which do I have?");
    expect(html).toContain("You run 0.1.0-beta.3");
    expect(html.indexOf('class="wn-how"')).toBeLessThan(html.indexOf('class="wn-badge-row'));
  });

  it("styles the badge and box from existing tokens, with no amber and no colour-only difference", () => {
    const css = readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
    expect(css).toContain(".news .wn-badge {");
    expect(css).toContain(".news .wn-badge.not { border-style: dashed;");
    expect(css).toContain(".news .wn-badge-row.split {");
    expect(css).toContain(".news .wn-how {");
    const badgeRules = css.slice(css.indexOf(".news .wn-badge {"));
    expect(badgeRules.slice(0, badgeRules.indexOf("}"))).not.toContain("var(--amber)");
  });


  it("keeps the release-step comment out of the page but in the file, so the next release knows what to add", () => {
    const source = readFileSync(path.join(__dirname, "..", "..", "..", "CHANGELOG.md"), "utf8");
    expect(source).toMatch(/<!--[\s\S]*release step[\s\S]*-->/i);
  });
});

describe("roadmap portal link", () => {
  it("is left out of the menu, the footer and the home page while no portal address is set", () => {
    for (const f of ["index.html", "about.html", "guides/install-boss-man.html"]) {
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
    expect(readFileSync(path.join(out, "about.html"), "utf8")).toContain('href="https://roadmap.example.com/p/abc">Open the roadmap');
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

  it("puts SoftwareApplication structured data on the home page only, and the check catches its loss", () => {
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read("index.html"));
    expect(JSON.parse(m![1])).toMatchObject({ "@type": "SoftwareApplication", name: "Boss Man", isAccessibleForFree: true });
    expect(read("about.html")).not.toContain("ld+json");
    const undo = edit("index.html", (h) => h.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ""));
    const problems: string[] = checkSite(dist);
    undo();
    expect(problems).toContain("index.html: missing SoftwareApplication structured data");
  });

  it("catches missing preview tags, a repeated title or description, and a noindex on a public page", () => {
    const undo = edit("about.html", (h) => h.replace(/<meta name="twitter:title"[^>]*>/, "").replace(/<title>[^<]*<\/title>/, "<title>Same</title>").replace("</head>", '<meta name="robots" content="noindex"></head>'));
    const undo2 = edit("whats-new.html", (h) => h.replace(/<title>[^<]*<\/title>/, "<title>Same</title>"));
    const problems: string[] = checkSite(dist);
    undo();
    undo2();
    expect(problems).toContain("about.html: missing twitter:title");
    expect(problems).toContain("about.html: has a noindex robots tag on a public page");
    expect(problems.some((p) => /whats-new\.html: same title as about\.html/.test(p))).toBe(true);
    expect(problems.some((p) => /404\.html: has a noindex/.test(p))).toBe(false);
  });

  it("catches a robots.txt that blocks search engines, is missing, or ignores the sitemap", () => {
    const f = path.join(dist, "robots.txt");
    const original = readFileSync(f, "utf8");
    writeFileSync(f, "User-agent: *\nDisallow: /\n");
    const blocked: string[] = checkSite(dist);
    rmSync(f);
    const missing: string[] = checkSite(dist);
    writeFileSync(f, original);
    expect(blocked).toContain("robots.txt blocks the whole site (Disallow: /)");
    expect(missing).toContain("robots.txt is missing");
    const withUrl = path.join(tmp, "dist-robots");
    build({ outDir: withUrl, siteUrl: "https://example.test", portalUrl: "" });
    writeFileSync(path.join(withUrl, "robots.txt"), "User-agent: *\nAllow: /\n");
    expect(checkSite(withUrl, { siteUrl: "https://example.test" })).toContain("robots.txt does not point to sitemap.xml");
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

describe("Umami page statistics", () => {
  const scriptUrl = "https://stats.example.com/script.js";
  const websiteId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  let tracked: string;
  beforeAll(() => {
    tracked = path.join(tmp, "dist-umami");
    build({ outDir: tracked, siteUrl: "https://example.test", portalUrl: "https://roadmap.example.com/p/abc", umamiScriptUrl: scriptUrl, umamiWebsiteId: websiteId });
  });
  const umami = { scriptUrl, origin: "https://stats.example.com", websiteId };

  it("puts the script on every page, with no cookie banner and nothing that stores a cookie", () => {
    const files = (readdirSync(tracked, { recursive: true }) as string[]).map(String).filter((f) => f.endsWith(".html"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const html = readFileSync(path.join(tracked, f), "utf8");
      expect(html, f).toContain(`<script defer src="${scriptUrl}" data-website-id="${websiteId}" data-do-not-track="true" data-exclude-search="true"></script>`);
    }
    expect(checkSite(tracked, { siteUrl: "https://example.test", umami })).toEqual([]);
  });

  it("names the Install, GitHub and Roadmap clicks", () => {
    const home = readFileSync(path.join(tracked, "index.html"), "utf8");
    expect(home).toMatch(/<a class="btn small" href="\/guides\/install-boss-man" data-umami-event="install-click">Install<\/a>/);
    expect(home).toMatch(/<a href="https:\/\/github\.com\/[^"]+" data-umami-event="github-click">GitHub<\/a>/);
    expect(home).toMatch(/href="https:\/\/roadmap\.example\.com\/p\/abc"[^>]*data-umami-event="roadmap-click"/);
    expect(home).not.toMatch(/data-umami-event="[^"]*"[^>]*data-umami-event=/);
  });

  it("lets the browser load the script and send numbers, and nothing else", () => {
    const headers = readFileSync(path.join(tracked, "_headers"), "utf8");
    expect(headers).toContain("script-src 'self' https://stats.example.com;");
    expect(headers).toContain("connect-src https://stats.example.com;");
    expect(readFileSync(path.join(dist, "_headers"), "utf8")).not.toContain("stats.example.com");
  });

  it("is off when not configured, and refuses half or odd settings", () => {
    expect(read("index.html")).not.toContain("data-website-id");
    expect(checkUmami("", "")).toBeNull();
    for (const [u, i] of [[scriptUrl, ""], ["", websiteId], ["http://stats.example.com/script.js", websiteId], ["https://user:pw@stats.example.com/s.js", websiteId], ["https://stats/s.js", websiteId], [scriptUrl, "not-an-id"]]) {
      expect(() => checkUmami(u, i), `${u} ${i}`).toThrow(/UMAMI_/);
    }
  });

  it("fails the pre-publish check when a page lacks the script or the policy blocks it", () => {
    const f = path.join(tracked, "about.html");
    const original = readFileSync(f, "utf8");
    writeFileSync(f, original.replace(/<script defer src="https:\/\/stats[^>]*><\/script>/, ""));
    const missing: string[] = checkSite(tracked, { siteUrl: "https://example.test", umami });
    writeFileSync(f, original.replace(`data-website-id="${websiteId}"`, 'data-website-id="00000000-0000-4000-8000-000000000000"'));
    const wrongId: string[] = checkSite(tracked, { siteUrl: "https://example.test", umami });
    writeFileSync(f, original);
    expect(missing).toEqual(["about.html: missing the Umami tracking script (visits to this page would not be counted)"]);
    expect(wrongId).toHaveLength(1);
    const h = path.join(tracked, "_headers");
    const headers = readFileSync(h, "utf8");
    writeFileSync(h, headers.replace(" https://stats.example.com", ""));
    const blocked: string[] = checkSite(tracked, { siteUrl: "https://example.test", umami });
    writeFileSync(h, headers);
    expect(blocked.join("\n")).toContain("_headers: the Content-Security-Policy does not allow https://stats.example.com");
  });
});
