import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

const ID = "00000000-0000-4000-8000-000000000001";
// Every owner route moved into routes/agents-runs.ts (BOS-1046): registered (not 404) and
// owner-session only (401 without it), exactly as before the move.
const ROUTES: Array<["GET" | "POST" | "PUT" | "PATCH" | "DELETE", string]> = [
  ["GET", `/api/agents/${ID}/avatar`],
  ["PUT", `/api/agents/${ID}/avatar`],
  ["DELETE", `/api/agents/${ID}/avatar`],
  ["PATCH", `/api/agents/${ID}`],
  ["POST", `/api/agents/${ID}/retire`],
  ["GET", `/api/agents/${ID}/history`],
  ["GET", `/api/agents/${ID}/notes`],
  ["POST", `/api/agents/${ID}/notes`],
  ["PATCH", `/api/agent-notes/${ID}`],
  ["DELETE", `/api/agent-notes/${ID}`],
  ["GET", "/api/runs"],
  ["POST", `/api/runs/${ID}/message`],
  ["GET", "/api/runs/recent"],
  ["GET", `/api/runs/${ID}/transcript`],
  ["GET", `/api/runs/${ID}/permissions`],
  ["POST", "/api/runs/cancel-all"],
  ["POST", `/api/runs/${ID}/cancel`],
];

it("every agent, agent-note and run route is registered and answers 401 without the owner's session", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const got = await Promise.all(ROUTES.map(async ([method, url]) => [method, url, (await built.app.inject({ method, url, payload: method === "GET" ? undefined : {} })).statusCode] as const));
  expect(got.filter(([, , status]) => status !== 401)).toEqual([]);
});
