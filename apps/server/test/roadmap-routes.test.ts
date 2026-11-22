import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { signedInOwner } from "./helpers/owner-session.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

const ID = "00000000-0000-4000-8000-000000000001";
// Every route in routes/roadmap.ts (BOS-298 step 15): registered (not 404) and owner-session only (401 without it).
const ROUTES: Array<["GET" | "POST" | "PATCH" | "DELETE", string]> = [
  ["POST", `/api/companies/${ID}/objectives`],
  ["POST", `/api/objectives/${ID}/key-results`],
  ["PATCH", `/api/key-results/${ID}`],
  ["DELETE", `/api/key-results/${ID}`],
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

it("the company-scoped GET addresses answer 404 for a company that doesn't exist and 200 for one that does (BOS-2253)", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const cookie = await signedInOwner(db);
  const get = (url: string) => built.app.inject({ method: "GET", url, headers: { cookie } });
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string } };
  for (const path of ["mcp-servers", "grants", "objectives", "plan", "open-tickets"]) {
    const missing = await get(`/api/companies/${ID}/${path}`);
    expect([path, missing.statusCode, missing.json()]).toEqual([path, 404, { error: "not_found" }]);
    expect([path, (await get(`/api/companies/${co.company.id}/${path}`)).statusCode]).toEqual([path, 200]);
  }
});
