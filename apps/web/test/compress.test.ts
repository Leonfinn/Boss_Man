import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { preCompressDir, shouldPreCompress, sidecarSizes } from "../compress";

const dirOf = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-compress-"));
  mkdirSync(path.join(dir, "assets"));
  return dir;
};

// BOS-411: the web build writes .br/.gz next to each asset so every install serves them from disk.
describe("the web build's pre-compression", () => {
  it("writes brotli and gzip copies that decompress to the original", async () => {
    const dir = dirOf();
    const text = `console.log("${"a bundle that is worth compressing ".repeat(200)}");`;
    writeFileSync(path.join(dir, "assets", "index-abc123.js"), text);
    const written = await preCompressDir(dir);
    expect(written).toEqual([{ file: "assets/index-abc123.js", bytes: text.length, saved: { br: expect.any(Number), gzip: expect.any(Number) } }]);
    const p = path.join(dir, "assets", "index-abc123.js");
    expect(brotliDecompressSync(readFileSync(`${p}.br`)).toString()).toBe(text);
    expect(gunzipSync(readFileSync(`${p}.gz`)).toString()).toBe(text);
    for (const suffix of [".br", ".gz"]) expect((await sidecarSizes(dir))[`assets/index-abc123.js${suffix}`]).toBeGreaterThan(0);
  });

  it("leaves the pages, source maps and files that do not shrink alone", async () => {
    const dir = dirOf();
    writeFileSync(path.join(dir, "index.html"), `<!doctype html>${"<p>x</p>".repeat(500)}`);
    writeFileSync(path.join(dir, "portal.html"), `<!doctype html>${"<p>x</p>".repeat(500)}`);
    writeFileSync(path.join(dir, "assets", "main-abc123.js.map"), "{}");
    writeFileSync(path.join(dir, "assets", "tiny.js"), "x");
    await preCompressDir(dir);
    expect(await sidecarSizes(dir)).toEqual({});
  });

  it("skips pages, maps and existing sidecars, and keeps every real asset", () => {
    for (const p of ["index.html", "portal.html", "assets/main-abc.js.map", "assets/main-abc.js.br", "assets/main-abc.js.gz"]) expect([p, shouldPreCompress(p)]).toEqual([p, false]);
    for (const p of ["assets/main-abc.js", "assets/app-abc.css", "manifest.webmanifest", "app-icons/boss-mark-192.png"]) expect([p, shouldPreCompress(p)]).toEqual([p, true]);
  });
});
