import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

const ID = "00000000-0000-4000-8000-000000000001";
// Every route in routes/features.ts (BOS-298 step 15): registered (not 404) and owner-session only (401 without it).
const ROUTES: Array<["GET" | "POST" | "PUT" | "PATCH" | "DELETE", string]> = [
  ["GET", `/api/companies/${ID}/feedback-settings`],
  ["PATCH", `/api/companies/${ID}/feedback-settings`],
  ["POST", `/api/companies/${ID}/feature-drivers`],
  ["PATCH", `/api/feature-drivers/${ID}`],
  ["DELETE", `/api/feature-drivers/${ID}`],
  ["POST", `/api/companies/${ID}/feature-areas`],
  ["PATCH", `/api/feature-areas/${ID}`],
  ["DELETE", `/api/feature-areas/${ID}`],
  ["PATCH", `/api/companies/${ID}/portal`],
  ["PUT", `/api/companies/${ID}/feedback/portal-logo`],
  ["DELETE", `/api/companies/${ID}/feedback/portal-logo`],
  ["GET", `/api/companies/${ID}/feedback/portal-logo`],
  ["POST", `/api/companies/${ID}/portal/rotate`],
  ["GET", `/api/companies/${ID}/features`],
  ["POST", `/api/companies/${ID}/features`],
  ["GET", `/api/features/${ID}`],
  ["PATCH", `/api/features/${ID}`],
  ["DELETE", `/api/features/${ID}`],
  ["POST", `/api/features/${ID}/tickets`],
  ["GET", `/api/companies/${ID}/feedback-customers`],
  ["GET", "/api/feedback/unprocessed"],
  ["GET", `/api/companies/${ID}/feedback`],
  ["POST", `/api/companies/${ID}/feedback`],
  ["GET", `/api/feedback/${ID}`],
  ["PATCH", `/api/feedback/${ID}`],
  ["DELETE", `/api/feedback/${ID}`],
  ["POST", `/api/feedback/${ID}/insights`],
  ["DELETE", `/api/insights/${ID}`],
];

it("every feature and feedback route is registered and answers 401 without the owner's session", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const got = await Promise.all(ROUTES.map(async ([method, url]) => [method, url, (await built.app.inject({ method, url, payload: method === "GET" ? undefined : {} })).statusCode] as const));
  expect(got.filter(([, , status]) => status !== 401)).toEqual([]);
});

it("the public portal answers without an owner session, so it is not owner-gated", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  // The portal is off by default, so it answers 404 rather than asking for the owner's session (401).
  const res = await built.app.inject({ method: "GET", url: "/api/portal" });
  expect(res.statusCode).not.toBe(401);
  expect(res.statusCode).toBe(404);
});
