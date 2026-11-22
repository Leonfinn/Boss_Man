import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { makeApp, signIn } from "./helpers.js";
import { BUNDLED_NTFY_URL, ntfySetupSaver } from "../src/routes/devices-notifications.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

const ID = "00000000-0000-4000-8000-000000000001";
// Every owner route in routes/devices-notifications.ts (BOS-298 step 15): registered (not 404) and
// owner-session only (401 without it).
const ROUTES: Array<["GET" | "POST" | "PUT" | "PATCH" | "DELETE", string]> = [
  ["GET", "/api/devices"],
  ["POST", "/api/devices"],
  ["PATCH", `/api/devices/${ID}`],
  ["DELETE", `/api/devices/${ID}`],
  ["GET", "/api/notifications"],
  ["POST", "/api/notifications/read"],
  ["GET", "/api/notification-settings"],
  ["PUT", "/api/notification-settings"],
  ["POST", "/api/notification-settings/test"],
  ["POST", "/api/notification-settings/phone-login"],
  ["GET", `/api/notification-settings/phone-login/${ID}`],
];

it("every device and notification route is registered and answers 401 without the owner's session", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const got = await Promise.all(ROUTES.map(async ([method, url]) => [method, url, (await built.app.inject({ method, url, payload: method === "GET" ? undefined : {} })).statusCode] as const));
  expect(got.filter(([, , status]) => status !== 401)).toEqual([]);
});

it("the phone taps answer without an owner session, so they are not owner-gated", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  // A tap is an ntfy action with a token, never a session: a non-JSON body gets the tap routes' own
  // 415 answer, not the owner check's 401.
  for (const url of ["/api/phone/got-it", "/api/phone/approve"]) {
    const res = await built.app.inject({ method: "POST", url, headers: { "content-type": "text/plain" }, payload: "x" });
    expect([url, res.statusCode, res.json()]).toEqual([url, 415, { ok: false, error: "json_only" }]);
  }
});

// BOS-1581: what "Set up ntfy" does with the token the host sealed back.
it("the setup saver keeps the token in the secrets store only, and a repeat changes nothing", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const save = ntfySetupSaver({ notes: built.notes, secretsSvc: built.secrets });
  const token = `tk_${"b".repeat(29)}`;
  await save({ token, topic: "abc123" });
  const first = (await built.notes.getSettings()).ntfy;
  expect(first).toMatchObject({ url: BUNDLED_NTFY_URL, topic: "abc123" });
  expect(first?.tokenSecretId).toBeTruthy();
  expect(await built.secrets.reveal(first!.tokenSecretId!)).toBe(token);
  expect(JSON.stringify(first)).not.toContain(token);
  // Again, with another topic the host was asked about: the owner's topic and the same secret stay.
  await save({ token, topic: "other" });
  expect((await built.notes.getSettings()).ntfy).toEqual(first);
  expect((await built.secrets.list()).filter((s) => s.name === "ntfy access token")).toHaveLength(1);
  // A new token replaces the saved one in place.
  const next = `tk_${"c".repeat(29)}`;
  await save({ token: next, topic: "abc123" });
  expect(await built.secrets.reveal(first!.tokenSecretId!)).toBe(next);
});

// BOS-1979: the save route itself, with the owner's session.
it("a bad topic is refused before any token is rotated or created; a good one still rotates", async () => {
  const t = await makeApp();
  close = () => t.close();
  const { cookie } = await signIn(t);
  const put = (ntfy: object | null, base: object) => t.app.inject({ method: "PUT", url: "/api/notification-settings", headers: { cookie }, payload: { ...base, ntfy } });
  const tokens = async () => (await t.secrets.list()).filter((s) => s.name === "ntfy access token");
  const { ntfy: _n, approve: _a, phoneAddress: _p, phoneContainer: _c, phoneTest: _t, phoneLogin: _l, ...base } = (await t.app.inject({ method: "GET", url: "/api/notification-settings", headers: { cookie } })).json();
  const url = "https://ntfy.example.com";
  // No token saved: a bad topic with a new token leaves no stray secret.
  const bad1 = await put({ url, topic: "a b", token: `tk_${"a".repeat(29)}` }, base);
  expect(bad1.statusCode).toBe(400);
  expect(JSON.stringify(bad1.json())).toContain("letters, digits");
  expect(await tokens()).toHaveLength(0);
  expect((await t.notes.getSettings()).ntfy).toBeNull();
  // A good save creates the token.
  const tokenA = `tk_${"b".repeat(29)}`;
  expect((await put({ url, topic: "good_topic", token: tokenA }, base)).statusCode).toBe(200);
  const [first] = await tokens();
  expect(await t.secrets.reveal(first!.id)).toBe(tokenA);
  // A bad topic with a new token keeps the old token and the old settings.
  const bad2 = await put({ url, topic: "a b", token: `tk_${"c".repeat(29)}` }, base);
  expect(bad2.statusCode).toBe(400);
  expect(await t.secrets.reveal(first!.id)).toBe(tokenA);
  expect(await tokens()).toHaveLength(1);
  expect((await t.notes.getSettings()).ntfy?.topic).toBe("good_topic");
  // A good topic with a new token rotates it in place.
  const tokenC = `tk_${"d".repeat(29)}`;
  expect((await put({ url, topic: "other-topic", token: tokenC }, base)).statusCode).toBe(200);
  expect(await t.secrets.reveal(first!.id)).toBe(tokenC);
  expect(await tokens()).toHaveLength(1);
  // The saved settings load as before.
  const loaded = (await t.app.inject({ method: "GET", url: "/api/notification-settings", headers: { cookie } })).json();
  expect(loaded.ntfy).toEqual({ url, topic: "other-topic", hasToken: true });
});

// BOS-1979: the route's schema refuses a bad topic with the same rule the settings use, before any secret is written.
it("the ntfy topic rule is shared and says what is allowed", async () => {
  const { NtfyTopic } = await import("../src/services/notifications.js");
  expect(NtfyTopic.safeParse("abc_DEF-123").success).toBe(true);
  for (const bad of ["a b", "", "x".repeat(65), "a/b"]) expect(NtfyTopic.safeParse(bad).success).toBe(false);
  const r = NtfyTopic.safeParse("a b");
  expect(r.success ? "" : r.error.issues[0]!.message).toContain("letters, digits");
});
