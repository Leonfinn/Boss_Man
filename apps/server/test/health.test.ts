import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

async function setup() {
  const { db, close: closeDb } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  let dbClosed = false;
  close = async () => {
    await built.app.close();
    if (!dbClosed) await closeDb();
  };
  return { app: built.app, killDb: async () => ((dbClosed = true), closeDb()) };
}

it("health is public, cheap and shows build facts only", async () => {
  const { app } = await setup();
  const r = await app.inject({ method: "GET", url: "/api/health" });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ ok: true, version: expect.any(String), commit: "dev", role: "single" });
});

it("ready pings the database and is 503 when it is gone", async () => {
  const { app, killDb } = await setup();
  expect((await app.inject({ method: "GET", url: "/api/ready" })).json()).toMatchObject({ ok: true, db: true, role: "single" });
  await killDb();
  const r = await app.inject({ method: "GET", url: "/api/ready" });
  expect(r.statusCode).toBe(503);
  expect(r.json()).toMatchObject({ ok: false, db: false });
});
