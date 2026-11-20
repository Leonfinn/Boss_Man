// Builds the static site: src/pages/*.html, src/guides/*.md and the repo's CHANGELOG.md (the "What's new" page) + shared
// header/footer -> dist/, plus public/ copied as
// is, _headers, _redirects, robots.txt and (when SITE_URL is set) sitemap.xml and the What's new feed whats-new.xml.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSite } from "./check.mjs";
import { checkUmami } from "./umami.mjs";
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

/**
 * The date (YYYY-MM-DD) a page's source files last changed in git, or "" when that can't be known truthfully: no git, a
 * shallow clone (every file would then show the clone's date) or files git has no history for. An empty answer leaves
 * <lastmod> out of the sitemap; a made-up date would teach search engines to ignore every date we send.
 */
export function gitLastModified(files, cwd = root) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (git("rev-parse", "--is-shallow-repository") !== "false") return "";
    const date = git("log", "-1", "--format=%cs", "--", ...files);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
  } catch {
    return "";
  }
}

/** The sitemap: one <url> per page; <lastmod> only where `lastmods` has a date for that path. */
export function sitemapXml(siteUrl, paths, lastmods = {}) {
  const urls = paths.map((p) => `  <url><loc>${siteUrl}${p}</loc>${lastmods[p] ? `<lastmod>${lastmods[p]}</lastmod>` : ""}</url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** An IndexNow key is 8 to 128 letters, digits or dashes. */
export function checkIndexNowKey(raw) {
  const key = (raw ?? "").trim();
  if (!key) return "";
  if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) throw new Error("INDEXNOW_KEY must be 8 to 128 letters, digits or dashes");
  return key;
}

export { checkUmami }; // lives in umami.mjs so check.mjs need not import this file

/** The named click events Umami records: Install, GitHub and Roadmap links (a data-umami-event attribute, no extra script). */
export function trackLinks(html, { installHref, repo, portal }) {
  return html.replace(/<a\s[^>]*>/g, (tag) => {
    if (/\sdata-umami-event=/.test(tag)) return tag;
    const href = /\shref="([^"]*)"/.exec(tag)?.[1];
    if (href === undefined) return tag;
    const clean = href.split(/[?#]/)[0].replace(/\/$/, "");
    let event = "";
    if (clean === installHref) event = "install-click";
    else if (clean === repo) event = "github-click";
    else if (portal && href.startsWith(portal)) event = "roadmap-click";
    return event ? tag.replace(/>$/, ` data-umami-event="${event}">`) : tag;
  });
}

/** Lets the page load the Umami script and send its numbers: the Content-Security-Policy otherwise allows only our own files. */
export function allowUmamiInHeaders(headers, origin) {
  return headers.replace(/script-src 'self'/, `script-src 'self' ${origin}`).replace(/; base-uri/, `; connect-src ${origin}; base-uri`);
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
      <a href="/guides/">Guides</a><a href="/whats-new">What's new</a>${roadmap}<a href="/about">About</a><a href="/faq">FAQ</a><a href="${vars.repo}">GitHub</a><a href="${vars.issues}">Report a problem</a><a href="${vars.licence}">Licence</a>
    </nav>
  </div>
</footer>`;
}

// Structured data for the home page: what Boss Man is, for search engines. Data blocks are not run, so the CSP does not block them.
function softwareApplication(config, meta, siteUrl) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: config.name,
    description: meta.description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Linux, macOS, Windows (with Docker)",
    isAccessibleForFree: true,
    license: "https://www.apache.org/licenses/LICENSE-2.0",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    ...(siteUrl && { url: siteUrl + "/", image: siteUrl + config.ogImage }),
    sameAs: [config.repo],
  };
}

function headTags(config, meta, siteUrl, umami) {
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
    siteUrl && `<link rel="alternate" type="application/atom+xml" title="Boss Man: What's new" href="/whats-new.xml">`,
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
    meta.path === "/" && `<script type="application/ld+json">${JSON.stringify(softwareApplication(config, meta, siteUrl)).replace(/</g, "\\u003c")}</script>`,
    `<script src="/menu.js" defer></script>`,
    // No cookies are set by this script. data-exclude-search keeps anything after "?" out of the recorded address.
    umami && `<script defer src="${escapeHtml(umami.scriptUrl)}" data-website-id="${umami.websiteId}" data-do-not-track="true" data-exclude-search="true"></script>`,
  ];
  return tags.filter(Boolean).join("\n");
}

function document({ config, vars, siteUrl, umami, meta, content, wrapMain = true }) {
  const body = wrapMain ? `<main id="main" tabindex="-1">\n${content.trim()}\n</main>` : content.trim();
  return `<!doctype html>
<html lang="en-GB">
<head>
${headTags(config, meta, siteUrl, umami)}
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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Reads the repo's CHANGELOG.md for the "What's new" page. Everything above the first `## ` heading (the file's title, its
 * note for GitHub readers and the release-step comment) is left out. Every `## ` heading must be a date such as
 * "16 November 2026", newest first and never twice, and no entry may carry a ticket number: the page is for users, in
 * plain words. Any slip stops the build, so a release step that adds an entry can't ship a broken page.
 */
export function readChangelog(file) {
  const name = path.basename(file);
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const start = text.search(/^## /m);
  if (start < 0) throw new Error(`${name}: no entries (each entry starts with "## <day> <Month> <year>")`);
  const source = text.slice(start);
  const ticket = /\bBOS-\d+\b/i.exec(source);
  if (ticket) throw new Error(`${name}: "${ticket[0]}" looks like a ticket number; describe the change in plain words instead`);
  let previous = Infinity;
  const dates = [];
  for (const m of source.matchAll(/^## (.*)$/gm)) {
    const heading = m[1].trim();
    const d = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(heading);
    const month = d ? MONTHS.indexOf(d[2]) : -1;
    const time = month >= 0 ? Date.UTC(+d[3], month, +d[1]) : NaN;
    if (Number.isNaN(time) || new Date(time).getUTCDate() !== +d[1]) throw new Error(`${name}: heading "${heading}" is not a date such as "16 November 2026"`);
    if (time >= previous) throw new Error(`${name}: "${heading}" is out of order (newest first, one entry per day)`);
    previous = time;
    dates.push(heading);
  }
  return { source, dates };
}

const FEED_LIMIT = 20;

/**
 * The Atom feed of the "What's new" page: one entry per `## <date>` section, newest first, at most FEED_LIMIT. Entry ids
 * and links are the page's own anchors; the content is the section's rendered HTML (relative links resolve against xml:base).
 */
export function whatsNewFeedXml(changelog, siteUrl, repo) {
  const { headings } = renderMarkdown(changelog.source, { name: "CHANGELOG.md", repo });
  const sections = changelog.source.split(/^(?=## )/m);
  const entries = sections.slice(0, FEED_LIMIT).map((section, i) => {
    const heading = changelog.dates[i];
    const [, d, month, y] = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(heading);
    const updated = new Date(Date.UTC(+y, MONTHS.indexOf(month), +d)).toISOString().replace(".000Z", "Z");
    const body = section.replace(/^## .*\n?/, "");
    const { html } = renderMarkdown(body, { name: "CHANGELOG.md", repo });
    const link = `${siteUrl}/whats-new#${headings[i].id}`;
    return { updated, xml: `  <entry>\n    <id>${escapeHtml(link)}</id>\n    <link rel="alternate" type="text/html" href="${escapeHtml(link)}"/>\n    <title>${escapeHtml(heading)}</title>\n    <updated>${updated}</updated>\n    <content type="html">${escapeHtml(html)}</content>\n  </entry>` };
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-GB" xml:base="${siteUrl}/">\n  <id>${siteUrl}/whats-new.xml</id>\n  <title>Boss Man: What's new</title>\n  <link rel="self" type="application/atom+xml" href="${siteUrl}/whats-new.xml"/>\n  <link rel="alternate" type="text/html" href="${siteUrl}/whats-new"/>\n  <updated>${entries[0].updated}</updated>\n${entries.map((e) => e.xml).join("\n")}\n</feed>\n`;
}

function whatsNewPage(changelog, ctx) {
  const { html, headings } = renderMarkdown(changelog.source, { name: "CHANGELOG.md", repo: ctx.vars.repo });
  const toc = headings.map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join("");
  const content = `<div class="wrap guide news">
<main id="main" class="g-main" tabindex="-1">
<h1>What's new</h1>
<p class="g-lead">The changes you will notice in Boss Man, newest first, in plain words. Each day's entry covers what was added that day. Boss Man has no numbered releases: to get these changes, <a href="/guides/updates-and-backups">update your server</a>.</p>
${ctx.feed ? `<p class="g-meta"><a href="/whats-new.xml">Follow by feed</a></p>\n` : ""}${html}
<p class="g-edit muted">The full history, with every change, is in the <a href="${ctx.vars.repo}/commits/main">list of changes on GitHub</a>.</p>
</main>
<nav class="g-toc" aria-label="Entries">
<p class="g-group">Entries</p>
<ul>${toc}</ul>
</nav>
</div>`;
  return { content, wrapMain: false };
}

export function build({ srcDir = path.join(root, "src"), publicDir = path.join(root, "public"), outDir = path.join(root, "dist"), siteUrl = process.env.SITE_URL ?? "", portalUrl, changelogFile = path.join(root, "..", "..", "CHANGELOG.md"), lastModified = gitLastModified, indexNowKey = process.env.INDEXNOW_KEY, umamiScriptUrl = process.env.UMAMI_SCRIPT_URL, umamiWebsiteId = process.env.UMAMI_WEBSITE_ID } = {}) {
  const umami = checkUmami(umamiScriptUrl, umamiWebsiteId);
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
  const sources = {}; // page path -> source files it is built from, for its sitemap date
  const write = (meta, parts, fileName, from = []) => {
    sources[meta.path] = from;
    let html = portalBlocks(document({ config, vars, siteUrl, umami, meta, ...parts }), Boolean(portal));
    if (umami) html = trackLinks(html, { installHref: config.installHref, repo: config.repo, portal });
    const target = path.join(outDir, fileName);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, html);
    if (fileName !== "404.html") paths.push(meta.path);
  };

  const pagesDir = path.join(srcDir, "pages");
  for (const file of readdirSync(pagesDir).filter((f) => f.endsWith(".html")).sort()) {
    const { meta, body } = parsePage(readFileSync(path.join(pagesDir, file), "utf8"), file);
    write(meta, { content: fill(portalBlocks(body, Boolean(portal)), vars, file) }, file, [path.join(pagesDir, file)]);
  }

  const guides = readGuides(path.join(srcDir, "guides"));
  for (const g of guides) {
    if (!g.meta.path) g.meta.path = `/guides/${g.slug}`;
    g.meta.nav = "guides";
  }
  if (guides.length) {
    const indexMeta = { title: "Guides: Boss Man", description: "Guides for installing and running Boss Man: install it, set up your first company, and use the board, Decisions, reviews, notifications and add-ons.", path: "/guides/", nav: "guides", body: "guide-page" };
    write(indexMeta, guidesIndex(guides, { vars }), "guides/index.html", guides.map((g) => path.join(srcDir, "guides", g.file)));
    for (const g of guides) {
      const meta = { title: `${g.meta.title}: Boss Man guides`, description: g.meta.description ?? g.meta.lead, path: g.meta.path, nav: g.meta.path === "/faq" ? "faq" : g.meta.path === "/guides/install-boss-man" ? "install" : "guides", body: "guide-page" };
      write(meta, guidePage(g, guides, { vars }), `${g.meta.path.slice(1)}.html`, [path.join(srcDir, "guides", g.file)]);
    }
  }

  const changelog = readChangelog(changelogFile);
  const newsMeta = { title: "What's new: Boss Man", description: `The changes you will notice in Boss Man, newest first, in plain words. Latest entry: ${changelog.dates[0]}.`, path: "/whats-new", nav: "whats-new", body: "guide-page" };
  write(newsMeta, whatsNewPage(changelog, { vars, feed: Boolean(siteUrl) }), "whats-new.html", [changelogFile]);
  if (siteUrl) writeFileSync(path.join(outDir, "whats-new.xml"), whatsNewFeedXml(changelog, siteUrl, config.repo));

  writeFileSync(path.join(outDir, "robots.txt"), `User-agent: *\nAllow: /\n${siteUrl ? `\nSitemap: ${siteUrl}/sitemap.xml\n` : ""}`);
  if (siteUrl) {
    const lastmods = Object.fromEntries(paths.map((p) => [p, lastModified(sources[p])]));
    writeFileSync(path.join(outDir, "sitemap.xml"), sitemapXml(siteUrl, paths, lastmods));
  }
  // IndexNow wants the key served at /<key>.txt with the key as its only content. The key comes from the environment (Boss Man's Secrets), never the repo.
  const key = checkIndexNowKey(indexNowKey);
  if (key) writeFileSync(path.join(outDir, `${key}.txt`), key);
  for (const f of ["_headers", "_redirects"]) {
    if (existsSync(path.join(srcDir, f))) cpSync(path.join(srcDir, f), path.join(outDir, f));
  }
  if (umami && existsSync(path.join(outDir, "_headers"))) {
    const file = path.join(outDir, "_headers");
    writeFileSync(file, allowUmamiInHeaders(readFileSync(file, "utf8"), umami.origin));
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
  if (!process.env.UMAMI_SCRIPT_URL) console.warn("WARNING: UMAMI_SCRIPT_URL and UMAMI_WEBSITE_ID are not set: this build has no visitor statistics");
  // The pre-publish check: a page missing its head tags or the Umami script stops the publish here, before anything is deployed.
  const problems = checkSite(outDir, { siteUrl: (process.env.SITE_URL ?? "").replace(/\/+$/, ""), umami: checkUmami(process.env.UMAMI_SCRIPT_URL, process.env.UMAMI_WEBSITE_ID) });
  if (problems.length) {
    console.error(problems.map((p) => "- " + p).join("\n"));
    console.error(`\nSite check failed: ${problems.length} problem(s)`);
    process.exit(1);
  }
}
