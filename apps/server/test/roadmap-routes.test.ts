import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

const ID = "00000000-0000-4000-8000-000000000001";
// Every route in routes/roadmap.ts (BOS-298 step 15): registered (not 404) and owner-session only (401 without it).
const ROUTES: Array<["GET" | "POST" | "PATCH" | "DELETE", string]> = [
  ["POST", `/api/companies/${ID}/objectives`],
  ["POST", `/api/objectives/${ID}/key-results`],
  ["POST", `/api/objectives/${ID}/milestones`],
  ["GET", `/api/companies/${ID}/objectives`],
  ["GET", "/api/roadmap"],
  ["GET", "/api/roadmap/features"],
  ["PATCH", `/api/objectives/${ID}`],
  ["GET", `/api/milestones/${ID}/tickets`],
  ["PATCH", `/api/milestones/${ID}`],
  ["DELETE", `/api/milestones/${ID}`],
  ["GET", `/api/companies/${ID}/plan`],
  ["GET", `/api/companies/${ID}/open-tickets`],
  ["GET", `/api/tickets/${ID}/links`],
  ["GET", `/api/tickets/${ID}/related`],
  ["DELETE", `/api/dependencies/${ID}`],
];

it("every objective and roadmap route is registered and answers 401 without the owner's session", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const got = await Promise.all(ROUTES.map(async ([method, url]) => [method, url, (await built.app.inject({ method, url, payload: method === "GET" ? undefined : {} })).statusCode] as const));
  expect(got.filter(([, , status]) => status !== 401)).toEqual([]);
});
