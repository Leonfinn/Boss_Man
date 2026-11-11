// A small Markdown converter for the guides (src/guides/*.md). It covers only what the guides use, and it fails the
// build on anything it does not understand, so a typo can't ship as stray text.
//
// Blocks: ## and ### headings (page h2 and h3, each with an id), paragraphs, bullet and numbered lists (one nested level),
// pipe tables, fenced code with a label, > quotes, images, and ::: containers.
//   ```sh Label shown above the command
//   :::note Before you start   ...   :::     amber box with a heading
//   :::worked ... :::                         green "It worked if" box
//   ![alt](/img/file.webp =1200x600 "Caption")  a figure; width and height are required
// Inline: `code`, **bold**, *italic*, [text](url). A url is /path, #id, https://... or @repo/... (the GitHub address
// from site.json). Anything else, such as javascript:, is a build error.

export const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function linkUrl(url, ctx) {
  if (url.startsWith("@repo")) return escapeHtml(ctx.repo + url.slice(5));
  if (/^(\/(?!\/)|#|https:\/\/)/.test(url)) return escapeHtml(url);
  throw new Error(`${ctx.name}: link to "${url}" is not allowed (use /path, #id, https://… or @repo/…)`);
}

/** Inline formatting. Code spans are lifted out first so their contents are never formatted. */
export function inline(text, ctx) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${linkUrl(url.replace(/&amp;/g, "&"), ctx)}">${label}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
}

const isBlank = (l) => l.trim() === "";
const listMarker = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function parseList(lines, ctx) {
  const items = [];
  for (const line of lines) {
    const m = listMarker.exec(line);
    if (m && m[1].length < 2) items.push({ ordered: /\d/.test(m[2]), text: m[3], nested: [], more: [] });
    else if (m && items.length) items[items.length - 1].nested.push(line.replace(/^\s{2,4}/, ""));
    else if (items.length) items[items.length - 1].more.push(line.trim());
    else throw new Error(`${ctx.name}: list line "${line}" has no item to belong to`);
  }
  const ordered = items[0].ordered;
  const li = items.map((it) => {
    const text = [it.text, ...it.more].join(" ");
    const nested = it.nested.length ? parseList(it.nested, ctx) : "";
    return `<li>${inline(text, ctx)}${nested}</li>`;
  });
  return ordered ? `<ol class="g-steps">${li.join("")}</ol>` : `<ul class="g-list">${li.join("")}</ul>`;
}

function parseTable(lines, ctx) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const head = cells(lines[0]);
  if (!/^[\s|:-]+$/.test(lines[1] ?? "")) throw new Error(`${ctx.name}: table without a separator row`);
  const body = lines.slice(2).map(cells);
  for (const r of body) if (r.length !== head.length) throw new Error(`${ctx.name}: table row has ${r.length} cells, expected ${head.length}: ${r.join(" | ")}`);
  const th = head.map((c) => `<th scope="col">${inline(c, ctx)}</th>`).join("");
  const tr = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`).join("");
  return `<div class="g-table" tabindex="0" role="region" aria-label="Table, scrolls sideways on a small screen"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

/** Returns { html, headings: [{id, text}] } where headings are the page's h2s. */
export function renderMarkdown(source, ctx) {
  ctx = { name: "markdown", repo: "", ...ctx };
  const headings = [];
  const ids = new Set();
  const uid = (text) => {
    let base = slugify(text) || "section";
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      const fence = /^```(\S*)\s*(.*)$/.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
        if (i >= lines.length) throw new Error(`${ctx.name}: a code block is never closed`);
        i++;
        const label = fence[2] ? `<p class="g-code-label">${inline(fence[2], ctx)}</p>` : "";
        out.push(`<div class="g-code">${label}<pre><code>${escapeHtml(body.join("\n"))}</code></pre><button type="button" class="copy" data-copy>Copy</button></div>`);
        continue;
      }

      const box = /^:::(\w+)\s*(.*)$/.exec(line);
      if (box) {
        const inner = [];
        i++;
        while (i < lines.length && !/^:::\s*$/.test(lines[i])) inner.push(lines[i++]);
        if (i >= lines.length) throw new Error(`${ctx.name}: a ::: box is never closed`);
        i++;
        const html = blocks(inner);
        if (box[1] === "note") out.push(`<aside class="note">${box[2] ? `<h2>${inline(box[2], ctx)}</h2>` : ""}${html}</aside>`);
        else if (box[1] === "worked") out.push(`<div class="check"><span class="tick" aria-hidden="true">✓</span><div><p><strong>It worked if</strong></p>${html}</div></div>`);
        else throw new Error(`${ctx.name}: unknown box "${box[1]}"`);
        continue;
      }

      const h = /^(#{2,3})\s+(.*)$/.exec(line);
      if (h) {
        const text = h[2].trim();
        const id = uid(text);
        if (h[1] === "##") headings.push({ id, text });
        const tag = h[1].length;
        out.push(`<h${tag} id="${id}">${inline(text, ctx)}</h${tag}>`);
        i++;
        continue;
      }
      if (/^#/.test(line)) throw new Error(`${ctx.name}: use ## or ### for headings, got "${line}"`);

      const img = /^!\[([^\]]*)\]\(([^\s)]+)\s+=(\d+)x(\d+)(?:\s+narrow=([^\s:)]+):(\d+)x(\d+))?(?:\s+"([^"]*)")?\)\s*$/.exec(line);
      if (img) {
        const [, alt, src, w, hgt, narrow, nw, nh, caption] = img;
        if (!alt) throw new Error(`${ctx.name}: image ${src} needs alt text`);
        const tag = `<img src="${escapeHtml(src)}" width="${w}" height="${hgt}" alt="${escapeHtml(alt)}" loading="lazy">`;
        // A diagram can have a tall narrow version for a phone: narrow=/img/x-narrow.svg:360x1530
        const picture = narrow ? `<picture><source media="(max-width: 900px)" srcset="${escapeHtml(narrow)}" width="${nw}" height="${nh}">${tag}</picture>` : tag;
        out.push(`<figure class="g-fig${narrow ? " diagram" : ""}">${picture}${caption ? `<figcaption>${inline(caption, ctx)}</figcaption>` : ""}</figure>`);
        i++;
        continue;
      }
      if (/^!\[/.test(line)) throw new Error(`${ctx.name}: image needs the form ![alt](/img/x.webp =WIDTHxHEIGHT "caption"), got "${line}"`);

      if (/^\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
        out.push(parseTable(rows, ctx));
        continue;
      }

      if (listMarker.test(line)) {
        const rows = [];
        while (i < lines.length && !isBlank(lines[i]) && !/^(```|:::|#|\|)/.test(lines[i])) rows.push(lines[i++]);
        out.push(parseList(rows, ctx));
        continue;
      }

      if (/^>\s?/.test(line)) {
        const rows = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) rows.push(lines[i++].replace(/^>\s?/, ""));
        out.push(`<blockquote>${blocks(rows)}</blockquote>`);
        continue;
      }

      const para = [];
      while (i < lines.length && !isBlank(lines[i]) && !/^(```|:::|#|\||!\[|>)/.test(lines[i]) && !listMarker.test(lines[i])) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(" "), ctx)}</p>`);
    }
    return out.join("\n");
  }

  const html = blocks(source.replace(/\r\n/g, "\n").split("\n"));
  return { html, headings };
}
