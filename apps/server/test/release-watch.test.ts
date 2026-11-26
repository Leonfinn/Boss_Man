import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
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
