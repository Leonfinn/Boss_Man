// Checks a built site: page heads, one h1, lang, alt text, and that every internal link,
// image and stylesheet url() points at a file that exists. Exits 1 and lists problems if not.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkUmami } from "./umami.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const attr = (tag, name) => new RegExp(`\\s${name}=("([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(2).find((v) => v !== undefined);

function resolves(dist, target) {
  const clean = target.split(/[?#]/)[0];
  if (clean === "" || clean === "/") return existsSync(path.join(dist, "index.html"));
  const file = path.join(dist, clean);
  return [file, `${file}.html`, path.join(file, "index.html")].some((f) => existsSync(f) && !f.endsWith(path.sep));
}

// robots.txt must exist, must not shut search engines out (a "Disallow: /" for any agent), and must name the sitemap when the site has one.
function checkRobots(dist, problems, siteUrl) {
  const file = path.join(dist, "robots.txt");
  if (!existsSync(file)) return problems.push("robots.txt is missing");
  const text = readFileSync(file, "utf8");
  if (/^\s*disallow:\s*\/\s*$/im.test(text)) problems.push("robots.txt blocks the whole site (Disallow: /)");
  if (!/^\s*user-agent:/im.test(text)) problems.push("robots.txt has no User-agent line");
  if (existsSync(path.join(dist, "sitemap.xml")) && !/^\s*sitemap:\s*https?:\/\//im.test(text)) problems.push("robots.txt does not point to sitemap.xml");
  if (siteUrl && !text.includes(`Sitemap: ${siteUrl}/sitemap.xml`)) problems.push(`robots.txt: expected "Sitemap: ${siteUrl}/sitemap.xml"`);
}

/** A small well-formedness test for the feed: tags nest and close, no bare `<` or `&` in text. Returns a problem or "". */
export function xmlProblem(text) {
  const body = text.replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack = [];
  let last = 0;
  const badText = (s) => (/</.test(s) ? "a stray <" : /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(s) ? "a bare &" : "");
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g)) {
    const bad = badText(body.slice(last, m.index));
    if (bad) return `${bad} in the text`;
    last = m.index + m[0].length;
    if (m[1]) {
      if (stack.pop() !== m[2]) return `</${m[2]}> closes the wrong tag`;
    } else if (!m[4]) stack.push(m[2]);
    if (!stack.length && last < body.length && body.slice(last).trim()) return "content after the closing tag";
  }
  const tail = badText(body.slice(last));
  if (tail) return `${tail} in the text`;
  if (stack.length) return `<${stack.at(-1)}> is never closed`;
  return last === 0 ? "no tags" : "";
}

// With SITE_URL the build writes whats-new.xml, so it must be there, well-formed and a feed with at least one entry.
function checkFeed(dist, problems, siteUrl) {
  if (!siteUrl) return;
  const file = path.join(dist, "whats-new.xml");
  if (!existsSync(file)) return problems.push("whats-new.xml is missing");
  const text = readFileSync(file, "utf8");
  const bad = xmlProblem(text);
  if (bad) return problems.push(`whats-new.xml is not well-formed XML: ${bad}`);
  if (!/^<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/m.test(text)) problems.push("whats-new.xml is not an Atom feed");
  if (!text.includes("<entry>")) problems.push("whats-new.xml has no entries");
}

/** `umami` ({ scriptUrl, origin, websiteId }, from checkUmami in build.mjs) makes every page need the Umami script and the policy allow it. */
export function checkSite(dist, { siteUrl = "", umami = null } = {}) {
  const problems = [];
  const pages = readdirSync(dist, { recursive: true }).map(String).filter((f) => f.endsWith(".html")).sort();
  if (pages.length === 0) problems.push("no pages found in " + dist);

  const internal = (page, kind, url) => {
    if (!url || /^(https?:|mailto:|tel:|#|data:)/i.test(url)) return;
    if (siteUrl && url.startsWith(siteUrl)) url = url.slice(siteUrl.length) || "/";
    if (!url.startsWith("/")) return problems.push(`${page}: ${kind} "${url}" is not an absolute site path`);
    if (!resolves(dist, url)) problems.push(`${page}: ${kind} "${url}" does not exist`);
  };

  checkRobots(dist, problems, siteUrl);
  checkFeed(dist, problems, siteUrl);
  const titles = new Map();
  const descriptions = new Map();
  for (const page of pages) {
    const html = readFileSync(path.join(dist, page), "utf8");
    const tags = (name) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
    const metaContent = (key, value) => {
      const m = tags("meta").find((t) => attr(t, key) === value);
      return m ? attr(m, "content") : undefined;
    };

    if (!/<html[^>]*\slang="[a-z]{2}/i.test(html)) problems.push(`${page}: <html> has no lang attribute`);
    const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1].trim();
    if (!title) problems.push(`${page}: missing <title>`);
    if (!metaContent("name", "description")) problems.push(`${page}: missing meta description`);
    for (const [key, value] of [["property", "og:title"], ["property", "og:description"], ["property", "og:image"], ["name", "twitter:card"], ["name", "twitter:title"], ["name", "twitter:description"], ["name", "twitter:image"]]) {
      if (!metaContent(key, value)) problems.push(`${page}: missing ${value}`);
    }
    // Every page needs its own title and description, or search results show the same words for different pages.
    for (const [what, value, seen] of [["title", title, titles], ["description", metaContent("name", "description"), descriptions]]) {
      if (!value) continue;
      if (seen.has(value)) problems.push(`${page}: same ${what} as ${seen.get(value)}`);
      else seen.set(value, page);
    }
    // 404 is the one page that may keep itself out of search; every other page must not.
    if (page !== "404.html" && /noindex/i.test(metaContent("name", "robots") ?? "")) problems.push(`${page}: has a noindex robots tag on a public page`);
    if (page === "index.html") {
      const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
        try { return [JSON.parse(m[1])]; } catch { problems.push(`${page}: JSON-LD is not valid JSON`); return []; }
      });
      if (!ld.some((d) => d["@type"] === "SoftwareApplication" && d.name)) problems.push(`${page}: missing SoftwareApplication structured data`);
    }
    if (siteUrl && page !== "404.html" && !tags("link").some((t) => attr(t, "rel") === "canonical")) problems.push(`${page}: missing canonical link`);
    const h1s = (html.match(/<h1[\s>]/gi) ?? []).length;
    if (h1s !== 1) problems.push(`${page}: has ${h1s} h1 headings, expected 1`);
    if (!/id="main"/.test(html)) problems.push(`${page}: no #main target for the skip link`);
    // The Content-Security-Policy allows only the site's own files, so an inline style or script would silently not apply.
    if (/<style[\s>]/i.test(html) || /\sstyle=["']/i.test(html)) problems.push(`${page}: inline style (the Content-Security-Policy blocks it)`);
    if (/<script(?![^>]*(\ssrc=|type="application\/ld\+json"))[^>]*>/i.test(html)) problems.push(`${page}: inline script (the Content-Security-Policy blocks it)`);
    if (umami && !tags("script").some((t) => attr(t, "src") === umami.scriptUrl && attr(t, "data-website-id") === umami.websiteId)) {
      problems.push(`${page}: missing the Umami tracking script (visits to this page would not be counted)`);
    }
    // Heading order: the first heading is the h1 and no level is skipped on the way down.
    let level = 0;
    for (const m of html.matchAll(/<h([1-6])[\s>]/gi)) {
      const n = Number(m[1]);
      if (level === 0 && n !== 1) problems.push(`${page}: the first heading is an h${n}, expected h1`);
      else if (n > level + 1 && level !== 0) problems.push(`${page}: heading jumps from h${level} to h${n}`);
      level = n;
    }

    for (const img of tags("img")) {
      const src = attr(img, "src");
      if (attr(img, "alt") === undefined) problems.push(`${page}: image ${src} has no alt attribute`);
      if (!attr(img, "width") || !attr(img, "height")) problems.push(`${page}: image ${src} has no width and height`);
      internal(page, "image", src);
    }
    for (const source of tags("source")) {
      for (const candidate of (attr(source, "srcset") ?? "").split(",")) internal(page, "image", candidate.trim().split(/\s+/)[0]);
    }
    for (const a of tags("a")) {
      const href = attr(a, "href");
      if (href === undefined) problems.push(`${page}: link without href`);
      else if (/^mailto:/i.test(href)) problems.push(`${page}: mailto link ${href} (the site has no email address)`);
      else internal(page, "link", href);
    }
    for (const t of tags("link")) if (["stylesheet", "icon", "apple-touch-icon", "preload"].includes(attr(t, "rel") ?? "")) internal(page, "asset", attr(t, "href"));
    for (const t of tags("script")) internal(page, "script", attr(t, "src"));
    internal(page, "og:image", metaContent("property", "og:image"));
    internal(page, "twitter:image", metaContent("name", "twitter:image"));
  }

  if (umami) {
    const headers = existsSync(path.join(dist, "_headers")) ? readFileSync(path.join(dist, "_headers"), "utf8") : "";
    const csp = /Content-Security-Policy:(.*)/i.exec(headers)?.[1] ?? "";
    if (csp && !(csp.includes(`script-src 'self' ${umami.origin}`) && csp.includes(`connect-src ${umami.origin}`))) {
      problems.push(`_headers: the Content-Security-Policy does not allow ${umami.origin} (the browser would block the tracking script)`);
    }
  }

  const cssFile =path.join(dist, "styles.css");
  if (existsSync(cssFile)) {
    for (const m of readFileSync(cssFile, "utf8").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) internal("styles.css", "url()", m[1]);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? path.join(root, "dist");
  const problems = checkSite(dist, { siteUrl: (process.env.SITE_URL ?? "").replace(/\/+$/, ""), umami: checkUmami(process.env.UMAMI_SCRIPT_URL, process.env.UMAMI_WEBSITE_ID) });
  if (problems.length) {
    console.error(problems.map((p) => "- " + p).join("\n"));
    console.error(`\n${problems.length} problem(s) found`);
    process.exit(1);
  }
  console.log("Site check passed");
}
