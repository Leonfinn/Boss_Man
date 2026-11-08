import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companies, deviceProfiles, owners } from "../src/db/schema.js";
import { buildBrief } from "../src/services/brief.js";
import { deviceProfilesService, DEVICE_PROFILES_MAX } from "../src/services/device-profiles.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

// Device profiles (BOS-641): one row per signed-in browser, replaced through its fingerprint, and
// only screen facts. A layout ticket is checked at these figures, so a bad row is dropped, never guessed.

const reading = (over: Record<string, unknown> = {}) => ({
  width: 840,
  height: 900,
  pixelRatio: 2.6,
  coarsePointer: true,
  displayMode: "standalone",
  units: { vh: 900, dvh: 800, svh: 800, lvh: 900, visual: 800 },
  afterScroll: false,
  ...over,
});

const report = (over: Record<string, unknown> = {}) => ({ label: "Brave · 840px · touch", browser: "Brave", fingerprint: "fp-brave", readings: [reading()], ...over });

/** A phone profile: the toolbar shows at load (100dvh 800 < 100vh 900) and hides after a scroll. */
const phoneReport = (over: Record<string, unknown> = {}) => report({ readings: [reading(), reading({ afterScroll: true })], ...over });

let t: TestApp;
let ownerId: string;
let cookie: string;
beforeEach(async () => {
  t = await makeApp();
  cookie = (await signIn(t)).cookie;
  ownerId = (await t.db.select({ id: owners.id }).from(owners))[0]!.id;
});
afterEach(async () => {
  await t.close();
});

describe("deviceProfilesService", () => {
  it("records a profile and a second report with the same fingerprint replaces the row, not adds one", async () => {
    const svc = deviceProfilesService(t.db);
    const a = await svc.report(ownerId, report());
    expect(a.label).toBe("Brave · 840px · touch");
    const b = await svc.report(ownerId, report({ label: "My foldable", readings: [reading({ width: 700 })] }));
    expect(b.id).toBe(a.id);
    const rows = await t.db.select().from(deviceProfiles).where(eq(deviceProfiles.ownerId, ownerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("My foldable");
  });

  it("lists newest first, renames, and removes only its owner's rows", async () => {
    const svc = deviceProfilesService(t.db);
    const a = await svc.report(ownerId, report());
    const b = await svc.report(ownerId, report({ fingerprint: "fp-phone" }));
    expect((await svc.list(ownerId)).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect((await svc.rename(ownerId, a.id, "Desk"))?.label).toBe("Desk");
    expect(await svc.remove(ownerId, a.id)).toBe(true);
    expect(await svc.remove(ownerId, a.id)).toBe(false);
    expect(await svc.remove("00000000-0000-0000-0000-000000000000", b.id)).toBe(false);
  });

  it("drops rows that don't parse (a hand-edited reading) rather than presenting them as facts", async () => {
    const svc = deviceProfilesService(t.db);
    await svc.report(ownerId, report());
    await t.db.update(deviceProfiles).set({ readings: [{ width: 1 }] as never }).where(eq(deviceProfiles.fingerprint, "fp-brave"));
    expect(await svc.list(ownerId)).toEqual([]);
  });

  it("keeps at most DEVICE_PROFILES_MAX, dropping the oldest, so a changed fingerprint can't grow the list", async () => {
    const svc = deviceProfilesService(t.db);
    for (let i = 0; i < DEVICE_PROFILES_MAX + 3; i++) await svc.report(ownerId, report({ fingerprint: `fp-${i}` }));
    expect(await t.db.select().from(deviceProfiles).where(eq(deviceProfiles.ownerId, ownerId))).toHaveLength(DEVICE_PROFILES_MAX);
  });

  it("puts a recorded device in the agent's brief, with its measured figures", async () => {
    await deviceProfilesService(t.db).report(ownerId, phoneReport());
    const [company] = await t.db.insert(companies).values({ name: "App Co" }).returning();
    const brief = await buildBrief(t.db, { companyId: company!.id, agentId: null, role: "worker", since: null, now: new Date() });
    expect(brief).toContain("Your devices");
    expect(brief).toContain("100dvh 800");
    expect(brief).toContain("840×900");
  });
});

describe("device routes", () => {
  it("is owner only", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/devices" })).statusCode).toBe(401);
  });

  it("lets the owner report, list, rename and forget a device", async () => {
    const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => t.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const post = await req("POST", "/api/devices", report());
    expect(post.statusCode).toBe(200);
    const saved = post.json();
    expect(saved.readings).toHaveLength(1);
    expect((await req("GET", "/api/devices")).json()).toHaveLength(1);
    const patch = await req("PATCH", `/api/devices/${saved.id}`, { label: "Foldable" });
    expect(patch.json().label).toBe("Foldable");
    expect((await req("DELETE", `/api/devices/${saved.id}`)).json()).toEqual({ ok: true });
    expect((await req("DELETE", `/api/devices/${saved.id}`)).statusCode).toBe(404);
  });
});
