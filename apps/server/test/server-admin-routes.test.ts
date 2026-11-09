import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

const ID = "00000000-0000-4000-8000-000000000001";
// Every route in routes/server-admin.ts (BOS-910): registered (not 404) and owner-session only (401 without it).
const ROUTES: Array<["GET" | "POST" | "PATCH" | "DELETE", string]> = [
  ["POST", `/api/agents/${ID}/wake`],
  ["GET", "/api/scheduler/queue"],
  ["POST", "/api/scheduler/tick"],
  ["GET", "/api/kill-switch"],
  ["POST", "/api/kill-switch"],
  ["POST", `/api/companies/${ID}/pause`],
  ["GET", "/api/maintenance"],
  ["GET", "/api/runner-report"],
  ["POST", "/api/maintenance/start"],
  ["POST", "/api/maintenance/cancel"],
  ["POST", "/api/maintenance/wrapup"],
  ["POST", "/api/maintenance/cancel-wrap"],
  ["GET", "/api/self-deploy"],
  ["POST", "/api/self-deploy/deploy-latest"],
  ["POST", "/api/self-deploy/update-runners"],
  ["POST", "/api/self-deploy/restart"],
  ["GET", `/api/companies/${ID}/deploy-targets`],
  ["POST", `/api/companies/${ID}/deploy-targets`],
  ["PATCH", `/api/deploy-targets/${ID}`],
  ["DELETE", `/api/deploy-targets/${ID}`],
  ["GET", "/api/deploys"],
];

it("every server-admin route is registered and answers 401 without the owner's session", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const got = await Promise.all(ROUTES.map(async ([method, url]) => [method, url, (await built.app.inject({ method, url, payload: method === "GET" ? undefined : {} })).statusCode] as const));
  expect(got.filter(([, , status]) => status !== 401)).toEqual([]);
});
