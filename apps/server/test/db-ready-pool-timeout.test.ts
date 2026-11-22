// BOS-2181 criterion 3: when the pool can't hand out a connection in time (the acquire timeout), /api/ready answers 503 with
// db:false rather than hanging. No Postgres: a real in-memory database whose execute() fails the way a full pool does.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
});

describe("/api/ready with a pool that can't give a connection", () => {
  it("returns 503 with db:false when acquiring a connection times out", async () => {
    const { db, close } = await openPglite();
    closers.push(close);
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
    closers.push(() => built.app.close());

    const ok = await built.app.inject({ method: "GET", url: "/api/ready" });
    expect(ok.statusCode).toBe(200);

    // What node-postgres rejects with when every connection is busy for connectionTimeoutMillis.
    (db as unknown as { execute: () => Promise<never> }).execute = () => Promise.reject(new Error("timeout exceeded when trying to connect"));
    const res = await built.app.inject({ method: "GET", url: "/api/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, db: false });
  });
});
