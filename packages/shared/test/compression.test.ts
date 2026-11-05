import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assetPathOf, PRECOMPRESSED_SUFFIX, PRECOMPRESSED_SUFFIX_LIST } from "../src/compression.js";

// BOS-411: the server serves pre-compressed assets, and the blue/green front door compresses responses.
const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

describe("compression sidecars", () => {
  it("strips the build's suffixes so the cache rule sees the asset the browser asked for", () => {
    expect(assetPathOf("/srv/web/assets/index-abc.js.br")).toBe("/srv/web/assets/index-abc.js");
    expect(assetPathOf("/srv/web/assets/index-abc.js.gz")).toBe("/srv/web/assets/index-abc.js");
    expect(assetPathOf("C:/web/assets/index-abc.css.gz")).toBe("C:/web/assets/index-abc.css");
    // A file that merely ends in the suffix, with nothing before the dot, is left alone.
    expect(assetPathOf("/srv/web/assets/gz")).toBe("/srv/web/assets/gz");
    expect(assetPathOf("/srv/web/index.html")).toBe("/srv/web/index.html");
  });

  it("lists the encodings @fastify/static serves and every suffix that must not be a route", () => {
    expect(PRECOMPRESSED_SUFFIX).toEqual({ br: ".br", gzip: ".gz" });
    expect(PRECOMPRESSED_SUFFIX_LIST).toEqual([".br", ".gz", ".zst"]);
  });
});

describe("the blue/green Caddyfile compresses at the front door", () => {
  const caddyfile = read("deploy/caddy/Caddyfile");
  // The site block starts at column 0; `servers :3100 {` inside the global block is indented.
  const site = (listen: string) => {
    const start = caddyfile.indexOf(`\n${listen} {`);
    expect(start, `${listen} site block exists`).toBeGreaterThanOrEqual(0);
    const end = caddyfile.indexOf("\n}", start);
    return caddyfile.slice(start, end);
  };

  it("has encode zstd gzip on the UI site (:3100) that carries the API and the runner websocket", () => {
    expect(site(":3100")).toContain("encode zstd gzip");
  });

  it("has encode zstd gzip on the portal site (:3101)", () => {
    expect(site(":3101")).toContain("encode zstd gzip");
  });

  it("puts encode only in the two site blocks, never in the global options or the (active) include", () => {
    const occurrences = caddyfile.match(/^\s*encode\b.*$/gm) ?? [];
    expect(occurrences).toEqual(["\tencode zstd gzip", "\tencode zstd gzip"]);
    // The include the host deployer rewrites is imported from its own file, so this one cannot carry encode.
    expect(caddyfile).toContain("import /etc/caddy-active/active.caddy");
  });
});
