// Checks a built site: page heads, one h1, lang, alt text, and that every internal link,
// image and stylesheet url() points at a file that exists. Exits 1 and lists problems if not.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const attr = (tag, name) => new RegExp(`\\s${name}=("([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(2).find((v) => v !== undefined);

function resolves(dist, target) {
  const clean = target.split(/[?#]/)[0];
  if (clean === "" || clean === "/") return existsSync(path.join(dist, "index.html"));
  const file = path.join(dist, clean);
  return [file, `${file}.html`, path.join(file, "index.html")].some((f) => existsSync(f) && !f.endsWith(path.sep));
}

export function checkSite(dist, { siteUrl = "" } = {}) {
  const problems = [];
  const pages = readdirSync(dist).filter((f) => f.endsWith(".html"));
  if (pages.length === 0) problems.push("no pages found in " + dist);

  const internal = (page, kind, url) => {
    if (!url || /^(https?:|mailto:|tel:|#|data:)/i.test(url)) return;
    if (siteUrl && url.startsWith(siteUrl)) url = url.slice(siteUrl.length) || "/";
    if (!url.startsWith("/")) return problems.push(`${page}: ${kind} "${url}" is not an absolute site path`);
    if (!resolves(dist, url)) problems.push(`${page}: ${kind} "${url}" does not exist`);
  };

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
    for (const [key, value] of [["property", "og:title"], ["property", "og:description"], ["property", "og:image"], ["name", "twitter:image"]]) {
      if (!metaContent(key, value)) problems.push(`${page}: missing ${value}`);
    }
    if (siteUrl && page !== "404.html" && !tags("link").some((t) => attr(t, "rel") === "canonical")) problems.push(`${page}: missing canonical link`);
    const h1s = (html.match(/<h1[\s>]/gi) ?? []).length;
    if (h1s !== 1) problems.push(`${page}: has ${h1s} h1 headings, expected 1`);
    if (!/id="main"/.test(html)) problems.push(`${page}: no #main target for the skip link`);

    for (const img of tags("img")) {
      const src = attr(img, "src");
      if (attr(img, "alt") === undefined) problems.push(`${page}: image ${src} has no alt attribute`);
      if (!attr(img, "width") || !attr(img, "height")) problems.push(`${page}: image ${src} has no width and height`);
      internal(page, "image", src);
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

  const cssFile = path.join(dist, "styles.css");
  if (existsSync(cssFile)) {
    for (const m of readFileSync(cssFile, "utf8").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) internal("styles.css", "url()", m[1]);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2] ?? path.join(root, "dist");
  const problems = checkSite(dist, { siteUrl: (process.env.SITE_URL ?? "").replace(/\/+$/, "") });
  if (problems.length) {
    console.error(problems.map((p) => "- " + p).join("\n"));
    console.error(`\n${problems.length} problem(s) found`);
    process.exit(1);
  }
  console.log("Site check passed");
}
