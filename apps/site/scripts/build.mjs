// Builds the static site: src/pages/*.html + shared header/footer -> dist/*.html, plus
// public/ copied as is, _headers, robots.txt and (when SITE_URL is set) sitemap.xml.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Splits a page into its `---` front matter (key: value lines) and its HTML body. */
export function parsePage(text, name) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${name}: missing front matter`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of ["title", "description", "path"]) {
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

function header(config, vars, current) {
  const links = config.nav
    .map((n) => {
      const href = fill(n.href, vars, "nav");
      const cur = n.key === current ? ' aria-current="page"' : "";
      return `<li><a href="${href}"${cur}>${escapeHtml(n.label)}</a></li>`;
    })
    .join("");
  return `<header class="site-header">
  <div class="wrap bar">
    <a class="brand" href="/"><img src="/img/boss-mark-64.png" srcset="/img/boss-mark-64.png 1x, /img/boss-mark-256.png 4x" width="40" height="40" alt=""><span>Boss Man</span><span class="sr-only"> home</span></a>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
    <nav id="site-nav" class="nav" aria-label="Main"><ul>${links}</ul><a class="btn" href="/get-started"${current === "get-started" ? ' aria-current="page"' : ""}>Get started</a></nav>
  </div>
</header>`;
}

function footer(vars) {
  return `<footer class="site-footer">
  <div class="wrap">
    <p class="alpha">Boss Man is alpha software for one owner, run on your own machine.</p>
    <ul class="foot-links">
      <li><a href="/features">Features</a></li>
      <li><a href="/how-it-works">How it works</a></li>
      <li><a href="/get-started">Get started</a></li>
      <li><a href="/faq">FAQ</a></li>
      <li><a href="${vars.repo}">Code on GitHub</a></li>
      <li><a href="${vars.licence}">Apache-2.0 licence</a></li>
    </ul>
    <p class="copy">© 2026 Boss Man</p>
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
    `<script src="/menu.js"></script>`,
  ];
  return tags.filter(Boolean).join("\n");
}

export function build({ srcDir = path.join(root, "src"), publicDir = path.join(root, "public"), outDir = path.join(root, "dist"), siteUrl = process.env.SITE_URL ?? "" } = {}) {
  siteUrl = siteUrl.replace(/\/+$/, "");
  const config = JSON.parse(readFileSync(path.join(srcDir, "site.json"), "utf8"));
  const vars = {
    repo: config.repo,
    guide: config.repo + config.guidePath,
    licence: config.repo + config.licencePath,
    issues: config.repo + config.issuesPath,
  };

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(publicDir, outDir, { recursive: true });
  cpSync(path.join(srcDir, "styles.css"), path.join(outDir, "styles.css"));
  cpSync(path.join(srcDir, "menu.js"), path.join(outDir, "menu.js"));

  const pagesDir = path.join(srcDir, "pages");
  const paths = [];
  for (const file of readdirSync(pagesDir).filter((f) => f.endsWith(".html")).sort()) {
    const { meta, body } = parsePage(readFileSync(path.join(pagesDir, file), "utf8"), file);
    const page = `<!doctype html>
<html lang="en">
<head>
${headTags(config, meta, siteUrl)}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header(config, vars, meta.nav)}
<main id="main" tabindex="-1">
${fill(body, vars, file).trim()}
</main>
${footer(vars)}
</body>
</html>
`;
    writeFileSync(path.join(outDir, file), page);
    if (file !== "404.html") paths.push(meta.path);
  }

  writeFileSync(path.join(outDir, "robots.txt"), `User-agent: *\nAllow: /\n${siteUrl ? `\nSitemap: ${siteUrl}/sitemap.xml\n` : ""}`);
  if (siteUrl) {
    const urls = paths.map((p) => `  <url><loc>${siteUrl}${p}</loc></url>`).join("\n");
    writeFileSync(path.join(outDir, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  }
  const headersFile = path.join(srcDir, "_headers");
  if (existsSync(headersFile)) cpSync(headersFile, path.join(outDir, "_headers"));
  return { outDir, pages: paths };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pages } = build();
  console.log(`Built ${pages.length + 1} pages to ${path.join(root, "dist")}${process.env.SITE_URL ? "" : " (SITE_URL not set: no canonical links or sitemap)"}`);
}
