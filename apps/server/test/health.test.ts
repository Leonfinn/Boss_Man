import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

async function setup() {
  // fresh: killDb must leave a really closed database, not one parked for reuse (BOS-657).
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
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
  expect(r.json()).toEqual({ ok: true, version: expect.any(String), commit: "dev", role: "single", colour: null, startedAt: expect.any(String) });
});

it("ready pings the database and is 503 when it is gone", async () => {
  const { app, killDb } = await setup();
  expect((await app.inject({ method: "GET", url: "/api/ready" })).json()).toMatchObject({ ok: true, db: true, role: "single" });
  await killDb();
  const r = await app.inject({ method: "GET", url: "/api/ready" });
  expect(r.statusCode).toBe(503);
  expect(r.json()).toMatchObject({ ok: false, db: false });
});

it("blue/green status is for the owner, off on a single server, and reads the other colour's health", async () => {
  const { app } = await setup();
  expect((await app.inject({ method: "GET", url: "/api/bluegreen" })).statusCode).toBe(401);
  const s = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const get = async () => (await app.inject({ method: "GET", url: "/api/bluegreen", headers: { cookie } })).json();
  expect(await get()).toEqual({ enabled: false });

  vi.stubEnv("BOSSMAN_COLOUR", "blue");
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => (asked.push(url), new Response(JSON.stringify({ role: "standby", commit: "abc", startedAt: "2026-10-23T10:00:00.000Z" }))));
  try {
    const on = await get();
    expect(asked).toEqual(["http://server-green:3100/api/health"]);
    expect(on).toMatchObject({ enabled: true, self: "blue", colours: [{ colour: "blue", up: true, role: "single" }, { colour: "green", up: true, role: "standby", commit: "abc" }] });
    vi.stubGlobal("fetch", async () => Promise.reject(new Error("ENOTFOUND")));
    expect((await get()).colours[1]).toEqual({ colour: "green", up: false, role: null, commit: null, startedAt: null });
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});
