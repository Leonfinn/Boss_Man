// The download: size cap, timeout, no redirect off the GitHub hosts, and the whole path with the real signed fixture.
import { afterEach, describe, expect, test } from "vitest";
import type { UpdaterError } from "../src/config.js";
import { fetchLimited, getVerifiedRelease } from "../src/release.js";
import type { VerifyFn } from "../src/verify.js";
import { fixture, startFileServer, testConfig } from "./helpers.js";

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});
const serve = async (files: Record<string, Buffer | string>, redirects: Record<string, string> = {}) => {
  const s = await startFileServer(files, redirects);
  closers.push(s.close);
  return s;
};
const refuse = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as UpdaterError;
  }
  throw new Error("expected a refusal");
};
const allow = ["127.0.0.1"];
const limits = { allowedHosts: allow, maxReleaseBytes: 1000, fetchTimeoutMs: 2000 };

describe("fetchLimited", () => {
  test("returns the body", async () => {
    const s = await serve({ "/a": "hello" });
    expect((await fetchLimited(`${s.base}/a`, limits)).toString()).toBe("hello");
  });
  test("refuses a body over the cap, declared or streamed", async () => {
    const s = await serve({ "/big": "x".repeat(2000) });
    expect((await refuse(fetchLimited(`${s.base}/big`, limits))).code).toBe("fetch_size");
  });
  test("refuses a host that is not allowed", async () => {
    expect((await refuse(fetchLimited("http://example.com/x", limits))).code).toBe("fetch_host");
  });
  test("follows a redirect to an allowed host but refuses one that leaves GitHub's hosts", async () => {
    const s = await serve({ "/real": "ok" }, { "/go": "/real", "/away": "http://203.0.113.9/x" });
    expect((await fetchLimited(`${s.base}/go`, limits)).toString()).toBe("ok");
    expect((await refuse(fetchLimited(`${s.base}/away`, limits))).code).toBe("fetch_host");
  });
  test("a 404 says there is no such release", async () => {
    const s = await serve({});
    expect((await refuse(fetchLimited(`${s.base}/none`, limits))).code).toBe("release_not_found");
  });
  test("nothing listening is a plain failure, not a crash", async () => {
    const s = await serve({});
    await s.close();
    expect((await refuse(fetchLimited(`${s.base}/x`, limits))).code).toBe("fetch_failed");
  });
});

describe("getVerifiedRelease on the real fixture", () => {
  const files = () => ({ "/Leonfinn/Boss_Man/releases/download/v0.1.0-beta.1/release.json": fixture("release.json"), "/Leonfinn/Boss_Man/releases/download/v0.1.0-beta.1/release.json.sigstore.json": fixture("release.json.sigstore.json") });
  const ok: VerifyFn = async () => undefined;

  test("downloads both files from this install's repository only, verifies, and checks the contents", async () => {
    const s = await serve(files());
    const cfg = testConfig({ UPDATER_GITHUB_BASE: s.base, UPDATER_ALLOWED_HOSTS: "127.0.0.1" });
    const rel = await getVerifiedRelease(cfg, "0.1.0-beta.1", { verifyFn: ok });
    expect(rel.version).toBe("0.1.0-beta.1");
    expect(s.hits).toEqual(["/Leonfinn/Boss_Man/releases/download/v0.1.0-beta.1/release.json", "/Leonfinn/Boss_Man/releases/download/v0.1.0-beta.1/release.json.sigstore.json"]);
  });

  test("a refused signature stops before the contents are read", async () => {
    const s = await serve(files());
    const cfg = testConfig({ UPDATER_GITHUB_BASE: s.base, UPDATER_ALLOWED_HOSTS: "127.0.0.1" });
    const e = await refuse(getVerifiedRelease(cfg, "0.1.0-beta.1", { verifyFn: async () => Promise.reject(Object.assign(new Error("x"), { code: "SIGNATURE_ERROR" })) }));
    expect(e.code).toBe("not_signed");
  });

  test("a release.json that is signed but for another version is refused", async () => {
    const f = files();
    const s = await serve({ ...f, "/Leonfinn/Boss_Man/releases/download/v0.1.0-beta.2/release.json": fixture("release.json"), "/Leonfinn/Boss_Man/releases/download/v0.1.0-beta.2/release.json.sigstore.json": fixture("release.json.sigstore.json") });
    const cfg = testConfig({ UPDATER_GITHUB_BASE: s.base, UPDATER_ALLOWED_HOSTS: "127.0.0.1" });
    const e = await refuse(getVerifiedRelease(cfg, "0.1.0-beta.2", { verifyFn: ok }));
    expect(e.code).toBe("bad_release");
  });

  test("a signature file that is not JSON is refused", async () => {
    const s = await serve({ ...files(), "/Leonfinn/Boss_Man/releases/download/v0.1.0-beta.1/release.json.sigstore.json": "not json" });
    const cfg = testConfig({ UPDATER_GITHUB_BASE: s.base, UPDATER_ALLOWED_HOSTS: "127.0.0.1" });
    expect((await refuse(getVerifiedRelease(cfg, "0.1.0-beta.1", { verifyFn: ok }))).code).toBe("not_signed");
  });
});
