import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownerPreferences, owners } from "../src/db/schema.js";
import { ownerPreferencesService } from "../src/services/owner-preferences.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

// The owner's per-login preferences (BOS-2689, shared with BOS-2669): saved on the server, one row per owner,
// so the choice survives a reload, a server restart and another browser on the same login. A failed save is
// refused and leaves the saved choice as it was; a missing row is every default.
// BOS-2690 adds the one-time keyboard tip's "seen" flag: off until shown and closed.

let t: TestApp;
let cookie: string;
let ownerId: string;
beforeEach(async () => {
  t = await makeApp();
  cookie = (await signIn(t)).cookie;
  ownerId = (await t.db.select({ id: owners.id }).from(owners))[0]!.id;
});
afterEach(async () => {
  await t.close();
});

const defaults = { singleLetterKeys: true, pinnedPages: [], keyboardTipSeen: false };

describe("owner preferences service", () => {
  it("gives every default until the owner changes something, and writes no row for that", async () => {
    expect(await ownerPreferencesService(t.db).get(ownerId)).toEqual(defaults);
    expect(await t.db.select().from(ownerPreferences)).toEqual([]);
  });

  it("saves only what changed and keeps the rest, and a second save updates the same row", async () => {
    const svc = ownerPreferencesService(t.db);
    expect(await svc.update(ownerId, { singleLetterKeys: false })).toEqual({ ...defaults, singleLetterKeys: false });
    // BOS-2669 fills the same store: a pin save must not turn the keys back on.
    // BOS-2669 fills the same store: a pin save must not turn the keys back on.
    expect(await svc.update(ownerId, { pinnedPages: [{ id: "updates" }, { id: "agents" }] })).toEqual({ ...defaults, singleLetterKeys: false, pinnedPages: [{ id: "updates" }, { id: "agents" }] });
    expect(await svc.get(ownerId)).toEqual({ ...defaults, singleLetterKeys: false, pinnedPages: [{ id: "updates" }, { id: "agents" }] });
    expect(await t.db.select().from(ownerPreferences).where(eq(ownerPreferences.ownerId, ownerId))).toHaveLength(1);
  });

  it("refuses a pin list over six, or a wrong type, and leaves the saved choice alone", async () => {
    const svc = ownerPreferencesService(t.db);
    await svc.update(ownerId, { singleLetterKeys: false });
    await expect(svc.update(ownerId, { pinnedPages: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }, { id: "g" }] })).rejects.toThrow();
    await expect(svc.update(ownerId, { singleLetterKeys: "off" })).rejects.toThrow();
    expect(await svc.get(ownerId)).toEqual({ ...defaults, singleLetterKeys: false });
  });

  it("keeps the tip's seen flag through other saves, so a later switch save does not bring the tip back (BOS-2690)", async () => {
    const svc = ownerPreferencesService(t.db);
    expect(await svc.update(ownerId, { keyboardTipSeen: true })).toEqual({ ...defaults, keyboardTipSeen: true });
    // Turning the keys off and on again leaves "seen" as it was.
    await svc.update(ownerId, { singleLetterKeys: false });
    expect(await svc.update(ownerId, { singleLetterKeys: true })).toEqual({ ...defaults, keyboardTipSeen: true });
  });
});

describe("preferences routes", () => {
  const req = (method: "GET" | "PATCH", payload?: unknown) => t.app.inject({ method, url: "/api/preferences", headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it("is owner only", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/preferences" })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "PATCH", url: "/api/preferences", payload: { singleLetterKeys: false } })).statusCode).toBe(401);
  });

  it("reads the defaults, saves the switch and reads it back on a later request, as another browser would", async () => {
    expect((await req("GET")).json()).toEqual(defaults);
    const saved = await req("PATCH", { singleLetterKeys: false });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ...defaults, singleLetterKeys: false });
    expect((await req("GET")).json()).toEqual({ ...defaults, singleLetterKeys: false });
    // And back on again, the way the list's "Turn them on" does it.
    expect((await req("PATCH", { singleLetterKeys: true })).json()).toEqual(defaults);
  });

  it("stores the tip as seen, and another browser on the same login reads it back (BOS-2690)", async () => {
    expect((await req("GET")).json()).toEqual(defaults);
    expect((await req("PATCH", { keyboardTipSeen: true })).json()).toEqual({ ...defaults, keyboardTipSeen: true });
    expect((await req("GET")).json()).toEqual({ ...defaults, keyboardTipSeen: true });
  });

  it("refuses a bad body with a plain message and leaves the saved choice as it was", async () => {
    await req("PATCH", { singleLetterKeys: false });
    const bad = await req("PATCH", { singleLetterKeys: "not a yes or no" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_request" });
    expect((await req("GET")).json()).toEqual({ ...defaults, singleLetterKeys: false });
  });
});
