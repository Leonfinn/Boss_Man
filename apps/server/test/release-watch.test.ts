import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { compareVersions, releaseWatchService, summarize } from "../src/services/release-watch.js";
import type { NotifyInput } from "../src/services/notifications.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const IMAGE_ENV = { BOSSMAN_IMAGE_INSTALL: "1", BOSSMAN_RELEASE_REPO: "example-org/boss-man", BOSSMAN_VERSION: "0.1.0-beta.2" };
const rel = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: tag.includes("-"), html_url: `https://github.com/example-org/boss-man/releases/tag/${tag}`, published_at: "2026-11-26T00:00:00Z", body: "## What's new\n\n- Faster **updates**\n- [Notes](https://example.com/x)", assets: [{ name: "release.json" }], ...extra });

async function setup(releases: unknown, env: Record<string, string> = IMAGE_ENV, opts: { status?: number; throws?: boolean; ntfy?: boolean } = {}) {
  const { db, close: c } = await openPglite();
  close = c;
  const sent: NotifyInput[] = [];
  const urls: string[] = [];
  let clock = Date.parse("2026-11-26T10:00:00Z");
  let body: unknown = releases;
  const svc = releaseWatchService(db, {
    env,
    now: () => new Date(clock),
    fetch: (async (url: string) => {
      urls.push(String(url));
      if (opts.throws) throw new Error("getaddrinfo ENOTFOUND");
      return new Response(JSON.stringify(body), { status: opts.status ?? 200 });
    }) as unknown as typeof fetch,
    notify: async (n) => void sent.push(n),
    hasNtfy: async () => opts.ntfy ?? false,
  });
  return { svc, sent, urls, advance: (ms: number) => void (clock += ms), set: (b: unknown) => void (body = b) };
}

describe("compareVersions", () => {
  it("orders pre-releases before their release and numbers numerically", () => {
    expect(compareVersions("0.1.0-beta.2", "0.1.0-beta.10")).toBe(-1);
    expect(compareVersions("0.1.0-beta.9", "0.1.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("summarize", () => {
  it("gives plain words: no headings marks, bullets or links", () => {
    expect(summarize("## What's new\n\n- Faster **updates**\n- [Notes](https://example.com/x)")).toBe("What's new Faster updates Notes");
    expect(summarize("x".repeat(400)).length).toBeLessThanOrEqual(280);
    expect(summarize(null)).toBe("");
  });
});

describe("release watch", () => {
  it("is off on a source install: no check, no note, nothing offered", async () => {
    const t = await setup([rel("v0.1.0-beta.3")], {});
    expect(t.svc.active).toBe(false);
    expect(await t.svc.check()).toEqual({ active: false });
    expect(await t.svc.status()).toEqual({ active: false });
    expect(t.urls).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("asks the configured repo, tells once per version with the version and notes link, and offers it", async () => {
    const t = await setup([rel("v0.1.0-beta.1"), rel("v0.1.0-beta.3"), rel("v0.1.0-beta.2")]);
    const v = await t.svc.check();
    expect(t.urls).toEqual(["https://api.github.com/repos/example-org/boss-man/releases?per_page=30"]);
    expect(v).toMatchObject({ active: true, channel: "beta", couldntCheck: false, available: { version: "0.1.0-beta.3" } });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ level: "note", title: "Boss Man 0.1.0-beta.3 is available", noPush: true, link: "#/settings/updates" });
    expect(t.sent[0]!.body).toContain("Faster updates");
    expect(t.sent[0]!.body).toContain("https://github.com/example-org/boss-man/releases/tag/v0.1.0-beta.3");
    // The same version is not announced again, but a newer one is.
    t.advance(25 * 3_600_000);
    await t.svc.check();
    expect(t.sent).toHaveLength(1);
    t.set([rel("v0.1.0-beta.4")]);
    await t.svc.check();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.title).toBe("Boss Man 0.1.0-beta.4 is available");
  });

  it("does not offer unsigned, draft, older or (on a stable install) pre-release versions", async () => {
    const t = await setup([rel("v0.1.0-beta.9", { assets: [] }), rel("v0.1.0-beta.8", { draft: true }), rel("v0.1.0-beta.1")]);
    expect((await t.svc.check()).active && (await t.svc.status())).toMatchObject({ available: null });
    expect(t.sent).toEqual([]);
    const s = await setup([rel("v0.2.0-beta.1"), rel("v0.2.0")], { ...IMAGE_ENV, BOSSMAN_VERSION: "0.1.0" });
    expect(await s.svc.check()).toMatchObject({ channel: "stable", available: { version: "0.2.0" } });
    const u = await setup([rel("v0.2.0-beta.1")], { ...IMAGE_ENV, BOSSMAN_VERSION: "0.1.0" });
    expect(await u.svc.check()).toMatchObject({ available: null });
  });

  it("says couldn't check quietly when GitHub fails, keeps the last answer, and retries within the hour", async () => {
    const bad = await setup([], IMAGE_ENV, { throws: true });
    expect(await bad.svc.check()).toMatchObject({ couldntCheck: true, available: null });
    expect(bad.sent).toEqual([]);
    expect(await bad.svc.due()).toBe(false);
    bad.advance(61 * 60_000);
    expect(await bad.svc.due()).toBe(true);
    const err = await setup([], IMAGE_ENV, { status: 503 });
    expect(await err.svc.check()).toMatchObject({ couldntCheck: true });
  });

  it("is due daily after a good check, and never when the owner turned it off", async () => {
    const t = await setup([rel("v0.1.0-beta.3")]);
    expect(await t.svc.due()).toBe(true);
    await t.svc.check();
    expect(await t.svc.due()).toBe(false);
    t.advance(23 * 3_600_000);
    expect(await t.svc.due()).toBe(false);
    t.advance(2 * 3_600_000);
    expect(await t.svc.due()).toBe(true);
    await t.svc.setOptions({ enabled: false });
    expect(await t.svc.due()).toBe(false);
  });

  it("tells nothing and calls nothing while switched off", async () => {
    const t = await setup([rel("v0.1.0-beta.3")]);
    await t.svc.setOptions({ enabled: false });
    expect(await t.svc.check()).toMatchObject({ enabled: false, available: null });
    expect(t.urls).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("sends to the phone only when the owner turned it on and ntfy is set up", async () => {
    const off = await setup([rel("v0.1.0-beta.3")], IMAGE_ENV, { ntfy: true });
    await off.svc.check();
    expect(off.sent[0]).toMatchObject({ noPush: true });
    const on = await setup([rel("v0.1.0-beta.3")], IMAGE_ENV, { ntfy: true });
    await on.svc.setOptions({ ntfy: true });
    await on.svc.check();
    expect(on.sent[0]).toMatchObject({ phoneOptIn: expect.any(String) });
    expect(on.sent[0]!.noPush).toBeUndefined();
    const noServer = await setup([rel("v0.1.0-beta.3")], IMAGE_ENV, { ntfy: false });
    await noServer.svc.setOptions({ ntfy: true });
    await noServer.svc.check();
    expect(noServer.sent[0]).toMatchObject({ noPush: true });
  });

  it("stops offering a version once the install runs it", async () => {
    const t = await setup([rel("v0.1.0-beta.3")], { ...IMAGE_ENV, BOSSMAN_VERSION: "0.1.0-beta.3" });
    expect(await t.svc.check()).toMatchObject({ active: true, available: null });
    expect(t.sent).toEqual([]);
  });
});

// BOS-2713: the Install button's server half. The updater is a fake that answers on its private address.
describe("install through the updater", () => {
  const SERVER_DIGEST = `sha256:${"7".repeat(64)}`;
  let shared: Awaited<ReturnType<typeof openPglite>>["db"] | undefined;
  let closeShared: (() => Promise<void>) | undefined;
  afterAll(async () => {
    await closeShared?.();
    shared = undefined;
  });
  const LINKED = { ...IMAGE_ENV, BOSSMAN_UPDATER_URL: "http://updater:3106", BOSSMAN_UPDATER_KEY_FILE: "/run/updater/key" };

  async function linkedSetup(env: Record<string, string> = LINKED, opts: { moveStatus?: number; releaseJson?: unknown; releaseStatus?: number; updaterDown?: boolean } = {}) {
    // One database for the whole block (each PGlite takes about 0.7 CPU-seconds and real memory); the stored watch row is cleared per call.
    if (!shared) {
      const o = await openPglite();
      shared = o.db;
      closeShared = o.close;
    }
    const db = shared;
    await db.delete(settings);
    const calls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
    let status: Record<string, unknown> = { stage: "idle", version: null, error: null, report: null };
    const svc = releaseWatchService(db, {
      env,
      readKey: () => "the-key\n",
      now: () => new Date("2026-11-26T10:00:00Z"),
      fetch: (async (url: string, init?: RequestInit) => {
        const u = String(url);
        const headers = new Headers(init?.headers);
        calls.push({ url: u, method: init?.method ?? "GET", auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (u.startsWith("https://api.github.com/")) return new Response(JSON.stringify([rel("v0.1.0-beta.3")]), { status: 200 });
        if (u.includes("/releases/download/")) return new Response(JSON.stringify(opts.releaseJson ?? { images: [{ name: "boss-man-launcher", digest: `sha256:${"1".repeat(64)}` }, { name: "boss-man-server", digest: SERVER_DIGEST }] }), { status: opts.releaseStatus ?? 200 });
        if (opts.updaterDown) throw new Error("ECONNREFUSED");
        if (u.endsWith("/status")) return new Response(JSON.stringify(status), { status: 200 });
        if (u.endsWith("/move")) return new Response(JSON.stringify(opts.moveStatus === 409 ? { error: "busy" } : opts.moveStatus === 400 ? { error: "bad_request", message: "version is not a release number." } : { accepted: true }), { status: opts.moveStatus ?? 202 });
        if (u.endsWith("/ack")) return new Response(JSON.stringify(status), { status: 200 });
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch,
      notify: async () => undefined,
      hasNtfy: async () => false,
    });
    return { svc, calls, setStatus: (s: Record<string, unknown>) => void (status = s) };
  }

  it("sends the updater exactly the version on offer and the server digest from release.json, with the key", async () => {
    const t = await linkedSetup();
    await t.svc.check();
    await t.svc.install("0.1.0-beta.3");
    const move = t.calls.find((c) => c.url.endsWith("/move"))!;
    expect(move).toMatchObject({ url: "http://updater:3106/move", method: "POST", auth: "Bearer the-key", body: { version: "0.1.0-beta.3", serverDigest: SERVER_DIGEST } });
    expect(Object.keys(move.body as object).sort()).toEqual(["serverDigest", "version"]);
    expect(t.calls.find((c) => c.url.includes("/releases/download/"))!.url).toBe("https://github.com/example-org/boss-man/releases/download/v0.1.0-beta.3/release.json");
  });

  it("refuses a version that is not the one on offer, and does not call the updater", async () => {
    const t = await linkedSetup();
    await t.svc.check();
    await expect(t.svc.install("9.9.9")).rejects.toMatchObject({ status: 409 });
    await expect(t.svc.install(undefined)).rejects.toMatchObject({ status: 409 });
    expect(t.calls.some((c) => c.url.endsWith("/move"))).toBe(false);
  });

  it("an install made before the link existed says so, and never calls anything", async () => {
    const t = await linkedSetup(IMAGE_ENV);
    const v = await t.svc.check();
    expect(v).toMatchObject({ active: true, install: { linked: false, updater: null } });
    await expect(t.svc.install("0.1.0-beta.3")).rejects.toThrow(/before the Install button existed/);
    expect(t.calls.filter((c) => !c.url.startsWith("https://api.github.com/"))).toEqual([]);
  });

  it("a source install offers and does nothing", async () => {
    const t = await linkedSetup({});
    await expect(t.svc.install("0.1.0-beta.3")).rejects.toMatchObject({ status: 409 });
    expect(t.calls).toEqual([]);
  });

  it("reads plainly when the updater is busy, refuses, or can't be reached; and when release.json is missing or has no server image", async () => {
    const busy = await linkedSetup(LINKED, { moveStatus: 409 });
    await busy.svc.check();
    await expect(busy.svc.install("0.1.0-beta.3")).rejects.toThrow(/already running/);
    const refused = await linkedSetup(LINKED, { moveStatus: 400 });
    await refused.svc.check();
    await expect(refused.svc.install("0.1.0-beta.3")).rejects.toThrow(/not a release number/);
    const down = await linkedSetup(LINKED, { updaterDown: true });
    await down.svc.check();
    await expect(down.svc.install("0.1.0-beta.3")).rejects.toThrow(/did not answer/);
    const gone = await linkedSetup(LINKED, { releaseStatus: 404 });
    await gone.svc.check();
    await expect(gone.svc.install("0.1.0-beta.3")).rejects.toThrow(/Couldn't download/);
    const noServer = await linkedSetup(LINKED, { releaseJson: { images: [{ name: "boss-man-launcher", digest: `sha256:${"1".repeat(64)}` }] } });
    await noServer.svc.check();
    await expect(noServer.svc.install("0.1.0-beta.3")).rejects.toThrow(/does not name a server image/);
    // Without a usable release.json nothing is sent to the updater at all.
    expect(gone.calls.some((c) => c.url.endsWith("/move"))).toBe(false);
    expect(noServer.calls.some((c) => c.url.endsWith("/move"))).toBe(false);
  });

  it("shows the updater's progress and report in the line, quietly empty when it can't be asked", async () => {
    const t = await linkedSetup();
    t.setStatus({ stage: "soaking", version: "0.1.0-beta.3", error: null, report: null });
    expect(await t.svc.check()).toMatchObject({ install: { linked: true, updater: { stage: "soaking", version: "0.1.0-beta.3" } } });
    t.setStatus({ stage: "rolled-back", version: "0.1.0-beta.3", error: { code: "colour_unhealthy", message: "It did not start." }, report: { level: "problem", text: "Went back.", acknowledged: false } });
    expect(await t.svc.status()).toMatchObject({ install: { updater: { stage: "rolled-back", error: { message: "It did not start." }, report: { level: "problem", text: "Went back." } } } });
    const down = await linkedSetup(LINKED, { updaterDown: true });
    expect(await down.svc.status()).toMatchObject({ install: { linked: true, updater: null } });
  });

  it("acknowledge tells the updater, with the key and no body", async () => {
    const t = await linkedSetup();
    await t.svc.acknowledge();
    expect(t.calls.find((c) => c.url.endsWith("/ack"))).toMatchObject({ method: "POST", auth: "Bearer the-key", body: undefined });
  });

  it("refuses an updater address that is not a plain private http host", async () => {
    for (const url of ["https://updater:3106", "http://updater:3106/x", "http://user@evil.example/", "ftp://updater"]) {
      const t = await linkedSetup({ ...LINKED, BOSSMAN_UPDATER_URL: url });
      expect(await t.svc.status()).toMatchObject({ install: { linked: false } });
    }
  });
});
