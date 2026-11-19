import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { build, checkIndexNowKey, gitLastModified, sitemapXml } from "../scripts/build.mjs";
import { changedUrls, notify, parseSitemap } from "../scripts/indexnow.mjs";

const KEY = "0123456789abcdef"; // made-up key
const SITE = "https://example.test";
const noSleep = async () => {};
const reply = (status: number) => vi.fn(async () => ({ status }) as Response);

const tmp = mkdtempSync(path.join(tmpdir(), "indexnow-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("sitemap", () => {
  it("writes lastmod only where a real date is known", () => {
    const xml = sitemapXml(SITE, ["/a", "/b"], { "/a": "2026-11-01", "/b": "" });
    expect(xml).toContain("<url><loc>https://example.test/a</loc><lastmod>2026-11-01</lastmod></url>");
    expect(xml).toContain("<url><loc>https://example.test/b</loc></url>");
  });

  it("is built with the dates the build is given, and robots.txt points to it", () => {
    const out = path.join(tmp, "dist");
    build({ outDir: out, siteUrl: SITE, portalUrl: "", lastModified: () => "2026-11-02", indexNowKey: "" });
    const urls = parseSitemap(readFileSync(path.join(out, "sitemap.xml"), "utf8"));
    expect(urls.length).toBeGreaterThan(5);
    expect(urls.every((u) => u.lastmod === "2026-11-02")).toBe(true);
    expect(readFileSync(path.join(out, "robots.txt"), "utf8")).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it("gives no date outside a full git history rather than a made-up one", () => {
    expect(gitLastModified(["nothing.md"], tmp)).toBe(""); // not a git repo
  });
});

describe("key file", () => {
  it("is served at /<key>.txt with the key alone, only when a key is set", () => {
    const out = path.join(tmp, "dist-key");
    build({ outDir: out, siteUrl: SITE, portalUrl: "", lastModified: () => "", indexNowKey: KEY });
    expect(readFileSync(path.join(out, `${KEY}.txt`), "utf8")).toBe(KEY);
  });

  it("refuses a key IndexNow would reject", () => {
    expect(() => checkIndexNowKey("short")).toThrow(/INDEXNOW_KEY/);
    expect(() => checkIndexNowKey("has space in it!")).toThrow(/INDEXNOW_KEY/);
    expect(checkIndexNowKey(undefined)).toBe("");
  });
});

describe("changed pages", () => {
  const next = [
    { loc: "https://example.test/a", lastmod: "2026-11-02" },
    { loc: "https://example.test/b", lastmod: "2026-11-01" },
    { loc: "https://example.test/c", lastmod: "2026-11-01" },
  ];
  it("lists new pages and pages whose date moved", () => {
    const previous = [
      { loc: "https://example.test/a", lastmod: "2026-10-01" },
      { loc: "https://example.test/b", lastmod: "2026-11-01" },
    ];
    expect(changedUrls(previous, next)).toEqual(["https://example.test/a", "https://example.test/c"]);
  });
  it("lists everything when there is no previous sitemap, and a page with no date", () => {
    expect(changedUrls(null, next)).toHaveLength(3);
    expect(changedUrls([{ loc: "https://example.test/a", lastmod: "" }], [{ loc: "https://example.test/a", lastmod: "" }])).toEqual(["https://example.test/a"]);
  });
});

describe("notify", () => {
  it("posts the host, key, key location and urls", async () => {
    const fetchImpl = reply(200);
    const r = await notify({ siteUrl: SITE, key: KEY, urls: [`${SITE}/a`], fetchImpl, sleep: noSleep });
    expect(r.status).toBe("sent");
    const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe("https://api.indexnow.org/indexnow");
    expect(JSON.parse(init.body as string)).toEqual({ host: "example.test", key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList: [`${SITE}/a`] });
  });

  it("retries once and succeeds without raising anything", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ status: 500 }).mockResolvedValueOnce({ status: 202 });
    const onFailure = vi.fn();
    const r = await notify({ siteUrl: SITE, key: KEY, urls: [`${SITE}/a`], fetchImpl, sleep: noSleep, onFailure });
    expect(r.status).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("after a second failure calls onFailure once and still returns instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const onFailure = vi.fn();
    const r = await notify({ siteUrl: SITE, key: KEY, urls: [`${SITE}/a`], fetchImpl, sleep: noSleep, onFailure });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.status).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toContain("offline");
  });

  it("does not throw when the failure hook itself fails", async () => {
    const r = await notify({ siteUrl: SITE, key: KEY, urls: [`${SITE}/a`], fetchImpl: reply(503), sleep: noSleep, onFailure: () => { throw new Error("hook"); } });
    expect(r.status).toBe("failed");
  });

  it("sends nothing without a key or when no page changed", async () => {
    const fetchImpl = reply(200);
    expect((await notify({ siteUrl: SITE, key: "", urls: [`${SITE}/a`], fetchImpl })).status).toBe("skipped");
    expect((await notify({ siteUrl: SITE, key: KEY, urls: [], fetchImpl })).status).toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
