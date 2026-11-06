// Pre-compressed web assets (BOS-411). The web build writes a `.gz` and `.br` copy next to each file it can
// compress, and the server hands those out through @fastify/static's `preCompressed` option when the browser
// asks for them. Every install gets this, with no proxy and no CPU spent per request; the blue/green Caddy
// front door also compresses API JSON on the way out.
//
// The compressed sibling on disk is `<file>.br` / `<file>.gz` (the suffixes @fastify/static appends for the
// encodings it can serve), so the static handler's `setHeaders` callback is handed that path rather than the
// file the browser asked for. assetPathOf strips the suffix for the cache rule. This module is server-only:
// the build plugin (apps/web/compress.ts) is deliberately self-contained, because the vite config is loaded
// by Node's own ESM resolver, which cannot import the TypeScript sources of this package.

/** The suffix @fastify/static appends for each encoding it can serve (its encodingExtensionMap). */
export const PRECOMPRESSED_SUFFIX: Readonly<Record<string, string>> = { br: ".br", gzip: ".gz" };

/** The sidecar suffixes the build writes and the server must never serve as files of their own. */
export const PRECOMPRESSED_SUFFIX_LIST: readonly string[] = [".br", ".gz", ".zst"];

/**
 * The path without a compression suffix: `/assets/index-abc.js.gz` -> `/assets/index-abc.js`.
 * A file whose own name ends in one of these (say `archive.gz`, with nothing before the dot) is untouched:
 * stripping would leave a nameless file.
 */
export function assetPathOf(file: string): string {
  for (const suffix of PRECOMPRESSED_SUFFIX_LIST) {
    if (!file.endsWith(suffix)) continue;
    const base = file.slice(0, -suffix.length);
    const name = base.slice(base.lastIndexOf("/") + 1);
    if (name.length > 0) return base;
  }
  return file;
}
