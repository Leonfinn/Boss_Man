import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

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
