import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity } from "../src/db/schema.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

async function setup() {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "PATCH", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const lines = async () => (await db.select().from(activity).where(and(eq(activity.companyId, company.id), eq(activity.kind, "settings")))).map((a) => a.summary);
  return { req, company, lines };
}

it("a feedback settings change writes one plain line per changed value, and nothing when nothing changed", async () => {
  const { req, company, lines } = await setup();
  const url = `/api/companies/${company.id}/feedback-settings`;
  const before = await lines();
  expect((await req("PATCH", url, { demandWeight: 5, ceoTriage: true })).statusCode).toBe(200);
  expect((await lines()).filter((s) => !before.includes(s)).sort()).toEqual(["Owner changed demand weight from 3 to 5", "Owner turned CEO triage on"].sort());
  const mid = await lines();
  // Same values again: no new lines.
  expect((await req("PATCH", url, { demandWeight: 5, ceoTriage: true })).statusCode).toBe(200);
  expect(await lines()).toEqual(mid);
  // Only one value changes: one line.
  expect((await req("PATCH", url, { ceoTriage: false })).statusCode).toBe(200);
  expect((await lines()).filter((s) => !mid.includes(s))).toEqual(["Owner turned CEO triage off"]);
});

it("an unknown company gets 404 not_found and writes nothing", async () => {
  const { req } = await setup();
  const res = await req("PATCH", `/api/companies/${randomUUID()}/feedback-settings`, { demandWeight: 4 });
  expect(res.statusCode).toBe(404);
  expect(res.json().error).toBe("not_found");
});
