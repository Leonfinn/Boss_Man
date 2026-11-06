// BOS-411: write a compressed copy of every built file that is worth compressing, so the server can serve
// it straight from disk (see packages/shared/src/compression.ts). The work happens once, at build time;
// requests then cost no CPU. Vite's own docs suggest a plugin that runs in closeBundle for exactly this.
//
// This file is loaded by the vite config, which Node resolves as plain ESM: it cannot import the TypeScript
// sources of @boss-man/shared, so the list of encodings and the skip rule live here and the server module
// mirrors only what it needs (the sidecar suffixes).
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/** Brotli's best level: this runs once per release, so the few extra seconds are worth the smaller file. */
const BROTLI_QUALITY = 11;

/** The suffixes @fastify/static serves (its encodingExtensionMap), and so the only ones worth writing. */
const SIDECARS = { br: ".br", gzip: ".gz" } as const;
type Encoding = keyof typeof SIDECARS;

const write: Record<Encoding, (buf: Buffer) => Buffer> = {
  br: (buf) => brotliCompressSync(buf, { params: { [zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlib.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
  gzip: (buf) => gzipSync(buf, { level: zlib.Z_BEST_COMPRESSION }),
};

const SUFFIXES = Object.values(SIDECARS);

/** Every file under `dir`, as paths relative to it, with forward slashes. */
export async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await filesUnder(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Whether the build should write compressed sidecars for a file in `dist`. The two HTML pages and any
 * source map are left alone: the pages are a few KB and never cached, and a map is only fetched when
 * someone is debugging. A file that is already a sidecar is skipped too, so a second build cannot nest them.
 */
export function shouldPreCompress(relativePath: string): boolean {
  const p = relativePath.replaceAll("\\", "/");
  if (p.endsWith(".html") || p.endsWith(".map")) return false;
  return !SUFFIXES.some((suffix) => p.endsWith(suffix));
}

/**
 * Compress each file in `dir` in place, writing `<file>.br` and `.gz` next to it. A sidecar is only kept
 * when it is smaller than the original: a tiny or already-compressed file stays one file. Returns what it
 * wrote, for the build log.
 */
export async function preCompressDir(dir: string): Promise<{ file: string; bytes: number; saved: Record<string, number> }[]> {
  const written: { file: string; bytes: number; saved: Record<string, number> }[] = [];
  for (const rel of (await filesUnder(dir)).sort()) {
    if (!shouldPreCompress(rel)) continue;
    const full = path.join(dir, rel);
    const buf = await readFile(full);
    const saved: Record<string, number> = {};
    for (const encoding of Object.keys(SIDECARS) as Encoding[]) {
      const packed = write[encoding](buf);
      if (packed.length >= buf.length) continue;
      await writeFile(`${full}${SIDECARS[encoding]}`, packed);
      saved[encoding] = buf.length - packed.length;
    }
    if (Object.keys(saved).length > 0) written.push({ file: rel, bytes: buf.length, saved });
  }
  return written;
}

/** The Vite plugin: after the build finishes writing `dist`, add the sidecars. Reported in the build log. */
export function preCompress(): Plugin {
  return {
    name: "boss-man:pre-compress",
    apply: "build",
    async closeBundle() {
      const dir = path.resolve("dist");
      const files = await preCompressDir(dir);
      if (files.length === 0) return;
      const saved = files.reduce((n, f) => n + (f.saved.br ?? 0), 0);
      const total = files.reduce((n, f) => n + f.bytes, 0);
      this.info(`pre-compressed ${files.length} files (${(total / 1024).toFixed(0)} KiB -> ${((total - saved) / 1024).toFixed(0)} KiB with brotli)`);
    },
  };
}

/** The sidecar files currently in `dir` and their sizes. Used by the build's own test. */
export async function sidecarSizes(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const rel of await filesUnder(dir)) {
    if (SUFFIXES.some((s) => rel.endsWith(s))) out[rel] = (await stat(path.join(dir, rel))).size;
  }
  return out;
}
