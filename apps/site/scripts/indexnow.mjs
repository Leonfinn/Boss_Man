// Tells IndexNow (Bing, Yandex and other engines that take it) which pages changed in a publish. Works on any host:
// everything comes from the environment or flags, nothing is hardcoded to one host or machine.
//
//   Before the deploy (optional):  node scripts/indexnow.mjs --fetch-previous "$TMPDIR/previous-sitemap.xml"
//   After the deploy succeeded:    node scripts/indexnow.mjs --previous "$TMPDIR/previous-sitemap.xml"
//
// Environment: SITE_URL (https origin) and INDEXNOW_KEY (from Boss Man's Secrets) are needed; DIST (built site, default
// ./dist), INDEXNOW_ENDPOINT (default https://api.indexnow.org/indexnow), INDEXNOW_RETRY_DELAY_MS (default 30000) and
// INDEXNOW_ON_FAILURE (a shell command the publish step supplies to raise the CEO ticket; it gets the reason in
// INDEXNOW_FAILURE) are optional.
//
// "Changed" = a page whose <lastmod> differs from the previous sitemap, or that is new, or that has no date to compare.
// With no previous sitemap every page is sent. A failed notice is retried once; a second failure runs INDEXNOW_ON_FAILURE.
// The script always exits 0: a search-engine notice must never block a publish.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkIndexNowKey } from "./build.mjs";

/** Reads { loc, lastmod } pairs out of a sitemap.xml text. */
export function parseSitemap(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
    loc: /<loc>\s*([^<]+?)\s*<\/loc>/.exec(m[1])?.[1] ?? "",
    lastmod: /<lastmod>\s*([^<]+?)\s*<\/lastmod>/.exec(m[1])?.[1] ?? "",
  })).filter((u) => u.loc);
}

/** URLs in `next` that are new, or whose lastmod differs from `previous` (a missing date on either side counts as changed). */
export function changedUrls(previous, next) {
  const before = new Map((previous ?? []).map((u) => [u.loc, u.lastmod]));
  return next.filter((u) => !before.has(u.loc) || !u.lastmod || before.get(u.loc) !== u.lastmod).map((u) => u.loc);
}

/** One IndexNow request. Returns "" on success (200 or 202) or a short reason. */
export async function submit({ endpoint, siteUrl, key, urls, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: new URL(siteUrl).host, key, keyLocation: `${siteUrl}/${key}.txt`, urlList: urls }),
    });
    return res.status === 200 || res.status === 202 ? "" : `IndexNow answered HTTP ${res.status}`;
  } catch (err) {
    return `IndexNow could not be reached (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Sends the notice, retrying once. Returns { status: "sent" | "skipped" | "failed", urls, reason }; never throws.
 * `onFailure(reason)` runs after the second failure.
 */
export async function notify({ siteUrl, key, urls, endpoint = "https://api.indexnow.org/indexnow", retryDelayMs = 30000, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onFailure = () => {} }) {
  if (!siteUrl || !key) return { status: "skipped", urls: [], reason: "SITE_URL or INDEXNOW_KEY is not set" };
  if (urls.length === 0) return { status: "skipped", urls, reason: "no page changed" };
  let reason = await submit({ endpoint, siteUrl, key, urls, fetchImpl });
  if (reason) {
    await sleep(retryDelayMs);
    reason = await submit({ endpoint, siteUrl, key, urls, fetchImpl });
  }
  if (!reason) return { status: "sent", urls, reason: "" };
  try {
    await onFailure(reason);
  } catch {
    // the failure hook must not block the publish either
  }
  return { status: "failed", urls, reason };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv, env) {
  const siteUrl = (env.SITE_URL ?? "").replace(/\/+$/, "");
  const fetchPrevious = arg(argv, "--fetch-previous");
  if (fetchPrevious) {
    try {
      const res = await fetch(`${siteUrl}/sitemap.xml`);
      if (res.ok) writeFileSync(fetchPrevious, await res.text());
      else console.log(`indexnow: no previous sitemap (HTTP ${res.status}); every page will be sent`);
    } catch (err) {
      console.log(`indexnow: no previous sitemap (${err instanceof Error ? err.message : err}); every page will be sent`);
    }
    return;
  }
  let key = "";
  try {
    key = checkIndexNowKey(env.INDEXNOW_KEY);
  } catch (err) {
    console.log(`indexnow: not sent: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const dist = path.resolve(env.DIST || "dist");
  const sitemapFile = path.join(dist, "sitemap.xml");
  if (!existsSync(sitemapFile)) {
    console.log(`indexnow: not sent: ${sitemapFile} does not exist`);
    return;
  }
  const previousFile = arg(argv, "--previous");
  const previous = previousFile && existsSync(previousFile) ? parseSitemap(readFileSync(previousFile, "utf8")) : null;
  const urls = changedUrls(previous, parseSitemap(readFileSync(sitemapFile, "utf8")));
  const result = await notify({
    siteUrl,
    key,
    urls,
    endpoint: env.INDEXNOW_ENDPOINT || undefined,
    retryDelayMs: env.INDEXNOW_RETRY_DELAY_MS ? Number(env.INDEXNOW_RETRY_DELAY_MS) : undefined,
    onFailure: (reason) => {
      const message = `IndexNow notice failed twice for ${urls.length} page(s): ${reason}`;
      console.log(`indexnow: ${message}`);
      if (env.INDEXNOW_ON_FAILURE) spawnSync(env.INDEXNOW_ON_FAILURE, { shell: true, stdio: "inherit", env: { ...env, INDEXNOW_FAILURE: message } });
    },
  });
  console.log(`indexnow: ${result.status}${result.reason ? ` (${result.reason})` : ""}, ${result.urls.length} page(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch((err) => console.log(`indexnow: not sent: ${err instanceof Error ? err.message : err}`));
}
