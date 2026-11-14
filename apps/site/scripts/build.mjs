// Builds the static site: src/pages/*.html and src/guides/*.md + shared header/footer -> dist/, plus public/ copied as
// is, _headers, _redirects, robots.txt and (when SITE_URL is set) sitemap.xml.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, inline, renderMarkdown } from "./markdown.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export { escapeHtml };

/** Splits a page into its `---` front matter (key: value lines) and its body. */
export function parsePage(text, name, required = ["title", "description", "path"]) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${name}: missing front matter`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of required) {
    if (!meta[key]) throw new Error(`${name}: front matter needs "${key}"`);
  }
  return { meta, body: m[2] };
}

/** Replaces {{name}} with a value from `vars`; an unknown name is a build error. */
export function fill(text, vars, name) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`${name}: unknown placeholder {{${key}}}`);
    return vars[key];
  });
}

/**
 * The public address of Boss Man's own feedback portal (Cloudflare). Empty means "not set": every roadmap link is then
 * left out, so the site never carries a home-network address. Anything that is not a public https address is refused.
 */
export function checkPortalUrl(raw) {
  const url = (raw ?? "").trim();
  if (!url) return "";
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`portal address "${url}" is not a web address`);
  }
  const host = u.hostname;
  const privateName = /^(localhost|.*\.(local|lan|internal|home|home\.arpa|ts\.net|localdomain))$/i.test(host);
  const ipLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  if (u.protocol !== "https:" || privateName || ipLiteral || !host.includes(".") || u.username || u.password) {
    throw new Error(`portal address must be a public https address with a domain name (no IP address, home-network name or login), got "${url}"`);
  }
  return u.href;
}

/** Drops <!--portal-->…<!--/portal--> blocks when there is no portal address; keeps the content when there is. */
export function portalBlocks(text, hasPortal) {
  return text.replace(/<!--portal-->([\s\S]*?)<!--\/portal-->/g, (_, inner) => (hasPortal ? inner : ""));
}

const GROUPS = ["Start here", "Everyday use", "Set it up your way", "Questions"];

function header(config, vars, current) {
  const links = config.nav
    .filter((n) => !n.portal || vars.portal)
    .map((n) => {
      const href = escapeHtml(fill(n.href, vars, "nav"));
      const cur = n.key === current ? ' aria-current="page"' : "";
      const ext = n.portal
        ? `<a href="${href}" class="ext"${cur}>${escapeHtml(n.label)}<span class="sr"> and feedback, on our feedback portal</span><span class="arrow" aria-hidden="true">↗</span><span class="menu-sub" aria-hidden="true">See what's planned, vote and suggest</span></a>`
        : `<a href="${href}"${cur}>${escapeHtml(n.label)}</a>`;
      return ext;
    })
    .join("\n      ");
  return `<header class="top">
  <div class="wrap">
    <a class="brand" href="/"><img src="/img/boss-mark-64.png" srcset="/img/boss-mark-64.png 1x, /img/boss-mark-256.png 4x" width="40" height="40" alt=""><span>Boss Man</span><span class="sr"> home</span></a>
    <nav aria-label="Main" id="main-menu">
      ${links}
      <a class="btn small" href="${escapeHtml(config.installHref)}"${current === "install" ? ' aria-current="page"' : ""}>Install</a>
    </nav>
    <button class="menu" type="button" aria-expanded="false" aria-controls="main-menu">Menu</button>
  </div>
</header>`;
}

function footer(vars) {
  const roadmap = vars.portal ? `<a href="${escapeHtml(vars.portal)}">Roadmap and feedback<span class="sr"> (opens our feedback portal)</span></a>` : "";
  return `<footer class="foot dark">
  <div class="wrap">
    <div>
      <a class="brand" href="/"><img src="/img/boss-mark-64.png" srcset="/img/boss-mark-64.png 1x, /img/boss-mark-256.png 4x" width="40" height="40" alt="">Boss Man</a>
      <p>Boss Man is in alpha. Its own agents build it, and some parts are still rough. Free and open source under the Apache 2.0 licence.</p>
    </div>
    <nav aria-label="Footer">
      <a href="/guides/">Guides</a>${roadmap}<a href="/about">About</a><a href="/faq">FAQ</a><a href="${vars.repo}">GitHub</a><a href="${vars.issues}">Report a problem</a><a href="${vars.licence}">Licence</a>
    </nav>
  </div>
</footer>`;
}

function headTags(config, meta, siteUrl) {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const abs = (p) => (siteUrl ? siteUrl + p : p);
  const tags = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    siteUrl && `<link rel="canonical" href="${abs(meta.path)}">`,
    `<link rel="icon" href="/img/favicon.ico" sizes="any">`,
    `<link rel="apple-touch-icon" href="/img/boss-mark-180.png">`,
    `<link rel="preload" href="/fonts/ibm-plex-sans-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>`,
    `<link rel="preload" href="/fonts/archivo-latin-wdth-normal.woff2" as="font" type="font/woff2" crossorigin>`,
    `<link rel="stylesheet" href="/styles.css">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${escapeHtml(config.name)}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    siteUrl && `<meta property="og:url" content="${abs(meta.path)}">`,
    `<meta property="og:image" content="${abs(config.ogImage)}">`,
    `<meta property="og:image:alt" content="${escapeHtml(config.ogAlt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${abs(config.ogImage)}">`,
    meta.robots && `<meta name="robots" content="${escapeHtml(meta.robots)}">`,
    `<script src="/menu.js" defer></script>`,
  ];
  return tags.filter(Boolean).join("\n");
}

function document({ config, vars, siteUrl, meta, content, wrapMain = true }) {
  const body = wrapMain ? `<main id="main" tabindex="-1">\n${content.trim()}\n</main>` : content.trim();
  return `<!doctype html>
<html lang="en-GB">
<head>
${headTags(config, meta, siteUrl)}
</head>
<body${meta.body ? ` class="${escapeHtml(meta.body)}"` : ""}>
<a class="skip" href="#main">Skip to the content</a>
${header(config, vars, meta.nav)}
${body}
${footer(vars)}
</body>
</html>
`;
}

/** Reads src/guides/*.md into { slug, meta, source } sorted by `order`. */
export function readGuides(guidesDir) {
  if (!existsSync(guidesDir)) return [];
  const guides = [];
  for (const file of readdirSync(guidesDir).filter((f) => f.endsWith(".md")).sort()) {
    const { meta, body } = parsePage(readFileSync(path.join(guidesDir, file), "utf8"), file, ["title", "description"]);
    for (const key of ["group", "order", "lead"]) if (!meta[key]) throw new Error(`${file}: front matter needs "${key}"`);
    if (!GROUPS.includes(meta.group)) throw new Error(`${file}: group "${meta.group}" is not one of ${GROUPS.join(", ")}`);
    if (!/^\d+$/.test(meta.order)) throw new Error(`${file}: order must be a number`);
    guides.push({ file, slug: file.replace(/\.md$/, ""), meta, source: body, order: +meta.order });
  }
  return guides.sort((a, b) => a.order - b.order);
}

function guideNav(guides, currentPath) {
  const groups = GROUPS.map((g) => {
    const items = guides.filter((x) => x.meta.group === g);
    if (!items.length) return "";
    const lis = items
      .map((x) => `<li><a href="${x.meta.path}"${x.meta.path === currentPath ? ' aria-current="page"' : ""}>${escapeHtml(x.meta.navTitle ?? x.meta.title)}</a></li>`)
      .join("");
    return `<p class="g-group">${g}</p>\n<ul>${lis}</ul>`;
  }).join("\n");
  return `<nav class="g-nav" aria-label="Guides">
<details class="g-toggle" open>
<summary>All guides</summary>
${groups}
</details>
</nav>`;
}

function guidePage(guide, guides, ctx) {
  const { meta } = guide;
  const { html, headings } = renderMarkdown(guide.source, { name: guide.file, repo: ctx.vars.repo });
  const i = guides.indexOf(guide);
  const prev = guides[i - 1];
  const next = guides[i + 1];
  const card = (g, cls, label) => (g ? `<a href="${g.meta.path}"${cls ? ` class="${cls}"` : ""} rel="${cls ? "next" : "prev"}"><span>${label}</span>${escapeHtml(g.meta.navTitle ?? g.meta.title)}</a>` : "<span></span>");
  const toc = headings.map((h) => `<li><a href="#${h.id}">${inline(h.text, { name: guide.file })}</a></li>`).join("");
  const content = `<div class="wrap guide">
${guideNav(guides, meta.path)}
<main id="main" class="g-main" tabindex="-1">
<p class="crumbs"><a href="/guides/">Guides</a> <span aria-hidden="true">/</span> ${escapeHtml(meta.group)}</p>
<h1>${escapeHtml(meta.title)}</h1>
<p class="g-lead">${inline(meta.lead, { name: guide.file, repo: ctx.vars.repo })}</p>
${meta.time ? `<p class="g-meta">${escapeHtml(meta.time)}</p>` : ""}
${html}
<nav class="g-next" aria-label="Next and previous guides">
${card(prev, "", "Previous")}
${card(next, "next", "Next")}
</nav>
<p class="g-edit muted">Something wrong or missing? <a href="${ctx.vars.issues}">Tell us on GitHub</a>.</p>
</main>
<nav class="g-toc" aria-label="On this page">
<p class="g-group">On this page</p>
<ul>${toc}</ul>
<img src="/img/boss-setup.webp" width="640" height="634" alt="" loading="lazy">
</nav>
</div>`;
  return { content, wrapMain: false };
}

function guidesIndex(guides, ctx) {
  const lists = GROUPS.map((g) => {
    const items = guides.filter((x) => x.meta.group === g && x.meta.path !== "/guides/");
    if (!items.length) return "";
    return `<h2>${g}</h2>
<ul class="g-cards">${items.map((x) => `<li><a href="${x.meta.path}"><strong>${escapeHtml(x.meta.title)}</strong><span>${escapeHtml(x.meta.description)}</span></a></li>`).join("")}</ul>`;
  }).join("\n");
  const content = `<div class="wrap guide index">
${guideNav(guides, "/guides/")}
<main id="main" class="g-main" tabindex="-1">
<h1>Guides</h1>
<p class="g-lead">Everything you need to install Boss Man, set up your first company and run it day to day, in the order a new owner needs it.</p>
${lists}
</main>
</div>`;
  return { content, wrapMain: false };
}

export function build({ srcDir = path.join(root, "src"), publicDir = path.join(root, "public"), outDir = path.join(root, "dist"), siteUrl = process.env.SITE_URL ?? "", portalUrl } = {}) {
  siteUrl = siteUrl.replace(/\/+$/, "");
  if (siteUrl && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(siteUrl)) {
    throw new Error(`SITE_URL must be an https origin such as https://example.com (no path, query or spaces), got "${siteUrl}"`);
  }
  const config = JSON.parse(readFileSync(path.join(srcDir, "site.json"), "utf8"));
  const portal = checkPortalUrl(portalUrl ?? process.env.PORTAL_URL ?? config.portalUrl);
  const vars = {
    repo: config.repo,
    guide: config.repo + config.guidePath,
    licence: config.repo + config.licencePath,
    issues: config.repo + config.issuesPath,
    portal,
  };

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(publicDir, outDir, { recursive: true });
  cpSync(path.join(srcDir, "styles.css"), path.join(outDir, "styles.css"));
  cpSync(path.join(srcDir, "menu.js"), path.join(outDir, "menu.js"));

  const paths = [];
  const write = (meta, parts, fileName) => {
    const html = portalBlocks(document({ config, vars, siteUrl, meta, ...parts }), Boolean(portal));
    const target = path.join(outDir, fileName);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, html);
    if (fileName !== "404.html") paths.push(meta.path);
  };

  const pagesDir = path.join(srcDir, "pages");
  for (const file of readdirSync(pagesDir).filter((f) => f.endsWith(".html")).sort()) {
    const { meta, body } = parsePage(readFileSync(path.join(pagesDir, file), "utf8"), file);
    write(meta, { content: fill(portalBlocks(body, Boolean(portal)), vars, file) }, file);
  }

  const guides = readGuides(path.join(srcDir, "guides"));
  for (const g of guides) {
    if (!g.meta.path) g.meta.path = `/guides/${g.slug}`;
    g.meta.nav = "guides";
  }
  if (guides.length) {
    const indexMeta = { title: "Guides: Boss Man", description: "Guides for installing and running Boss Man: install it, set up your first company, and use the board, Decisions, reviews, notifications and add-ons.", path: "/guides/", nav: "guides", body: "guide-page" };
    write(indexMeta, guidesIndex(guides, { vars }), "guides/index.html");
    for (const g of guides) {
      const meta = { title: `${g.meta.title}: Boss Man guides`, description: g.meta.description ?? g.meta.lead, path: g.meta.path, nav: g.meta.path === "/faq" ? "faq" : g.meta.path === "/guides/install-boss-man" ? "install" : "guides", body: "guide-page" };
      write(meta, guidePage(g, guides, { vars }), `${g.meta.path.slice(1)}.html`);
    }
  }

  writeFileSync(path.join(outDir, "robots.txt"), `User-agent: *\nAllow: /\n${siteUrl ? `\nSitemap: ${siteUrl}/sitemap.xml\n` : ""}`);
  if (siteUrl) {
    const urls = paths.map((p) => `  <url><loc>${siteUrl}${p}</loc></url>`).join("\n");
    writeFileSync(path.join(outDir, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  }
  for (const f of ["_headers", "_redirects"]) {
    if (existsSync(path.join(srcDir, f))) cpSync(path.join(srcDir, f), path.join(outDir, f));
  }
  return { outDir, pages: paths };
}

// Cloudflare Pages sets CF_PAGES; a deploy build without SITE_URL would ship with no canonical links, og:image URL or sitemap.
export function requireSiteUrlOnPages(env = process.env) {
  if (env.CF_PAGES && !env.SITE_URL) throw new Error("CF_PAGES is set but SITE_URL is not: set SITE_URL to the site's https origin (for example https://example.com)");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  requireSiteUrlOnPages();
  const outDir = process.env.SITE_OUT || path.join(root, "dist"); // SITE_OUT: build somewhere else, so two builds never share a folder
  const { pages } = build({ outDir });
  console.log(`Built ${pages.length + 1} pages to ${outDir}${process.env.SITE_URL ? "" : " (SITE_URL not set: no canonical links or sitemap)"}`);
}
