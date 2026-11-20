import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
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

// BOS-1979: the route's schema refuses a bad topic with the same rule the settings use, before any secret is written.
it("the ntfy topic rule is shared and says what is allowed", async () => {
  const { NtfyTopic } = await import("../src/services/notifications.js");
  expect(NtfyTopic.safeParse("abc_DEF-123").success).toBe(true);
  for (const bad of ["a b", "", "x".repeat(65), "a/b"]) expect(NtfyTopic.safeParse(bad).success).toBe(false);
  const r = NtfyTopic.safeParse("a b");
  expect(r.success ? "" : r.error.issues[0]!.message).toContain("letters, digits");
});
