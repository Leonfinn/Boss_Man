// BOS-1843: a size limit on what the app downloads before its first screen. Every page is a chunk fetched when it
// is first opened, so index.html only names the shell: the entry script, React and what they import at once.
// If a page (or a heavy library) slips back into that set, the build fails and names the biggest files.
//
// Loaded by the vite config as plain ESM, so, like compress.ts, it imports nothing from the workspace.
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/**
 * The limits, set about 10% above the size after route splitting (raw 444.1 kB, gzip 141.2 kB, BOS-1843; before it: 1,367 kB raw, 393 kB gzip). Raise one only
 * on purpose, in a change that says why the first screen needs more; a new page or a new library belongs in a chunk
 * that loads when it is opened (`lazyPage` in src/lazy-page.tsx).
 */
export const FIRST_LOAD_LIMIT = { rawBytes: 490_000, gzipBytes: 155_000 } as const;

/** The JS files index.html loads up front: its scripts and modulepreloads, as paths under the build folder. */
export function firstLoadFiles(html: string): string[] {
  const found = new Set<string>();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    const isScript = /^<script\b/.test(tag) && /\btype=["']module["']/.test(tag);
    const isPreload = /^<link\b/.test(tag) && /\brel=["']modulepreload["']/.test(tag);
    if (!isScript && !isPreload) continue;
    const src = /\b(?:src|href)=["']([^"']+)["']/.exec(tag)?.[1];
    if (src && src.split("?")[0]!.endsWith(".js")) found.add(src.replace(/^\.?\//, ""));
  }
  return [...found];
}

export type FirstLoad = { files: Array<{ file: string; raw: number; gzip: number }>; raw: number; gzip: number };

/** Size what index.html loads first, raw and gzipped (level 9: the figure a good server sends, near the .br/.gz sidecars). */
export function measureFirstLoad(distDir: string, html = readFileSync(path.join(distDir, "index.html"), "utf8")): FirstLoad {
  const files = firstLoadFiles(html).map((file) => {
    const buf = readFileSync(path.join(distDir, file));
    return { file, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
  });
  return { files, raw: files.reduce((n, f) => n + f.raw, 0), gzip: files.reduce((n, f) => n + f.gzip, 0) };
}

/** What is over the limit, as sentences; empty when the first load fits. */
export function firstLoadProblems(m: FirstLoad, limit: { rawBytes: number; gzipBytes: number } = FIRST_LOAD_LIMIT): string[] {
  const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;
  const problems: string[] = [];
  if (m.raw > limit.rawBytes) problems.push(`first-load JS is ${kb(m.raw)}, over the ${kb(limit.rawBytes)} limit`);
  if (m.gzip > limit.gzipBytes) problems.push(`first-load JS is ${kb(m.gzip)} gzipped, over the ${kb(limit.gzipBytes)} limit`);
  if (problems.length > 0) {
    const biggest = [...m.files].sort((a, b) => b.raw - a.raw).slice(0, 5);
    problems.push(`biggest files loaded first: ${biggest.map((f) => `${f.file} ${kb(f.raw)}`).join(", ")}`);
    problems.push("load pages with lazyPage (src/lazy-page.tsx) and heavy libraries with import(), so they load when opened (BOS-1843)");
  }
  return problems;
}

/** The Vite plugin: after the bundle is written, fail the build when the first load is over the limit. */
export function firstLoadLimit(): Plugin {
  return {
    name: "boss-man:first-load-limit",
    apply: "build",
    closeBundle() {
      // A build under vitest (NODE_ENV=test) bundles React's development build, which is far bigger; only the
      // production build is what the owner downloads, so only it is held to the limit.
      if (process.env.NODE_ENV !== "production") return;
      const m = measureFirstLoad(path.resolve("dist"));
      this.info(`first load: ${m.files.length} files, ${(m.raw / 1000).toFixed(1)} kB (${(m.gzip / 1000).toFixed(1)} kB gzipped)`);
      const problems = firstLoadProblems(m);
      if (problems.length > 0) this.error(problems.join("\n"));
    },
  };
}
