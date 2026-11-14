// BOS-1435 (DR-060): a check worker's own token and socket, end to end on the real app. The worker socket carries check
// messages only; a worker token opens nothing on the runner's routes, and a runner token doesn't open the worker socket.
// The owner's routes add (token shown once), turn off and remove a worker, and turning off or removing closes its socket.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { RunnerConnection } from "@boss-man/runner";
import { PROTOCOL_VERSION, WORKER_FEATURES } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkWorkers } from "../src/db/schema.js";

const HEARTBEAT = 100;
const COMMIT = "c".repeat(40);

async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, heartbeatMs: HEARTBEAT });
  const app = built.app;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const setupRes = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${setupRes.cookies.find((c) => c.name === "bm_session")!.value}`;
  const companyId = (await app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "Worker Co" } })).json().company.id as string;
  const reg = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/runner`, headers: { cookie } })).json() as { runnerId: string; token: string };
  const addWorker = async (body: Record<string, unknown> = {}) => {
    const res = await app.inject({ method: "POST", url: "/api/settings/check-workers", headers: { cookie }, payload: { name: "Hall NAS", companyIds: [companyId], slots: 2, checkThreads: 4, checkMemoryMb: 14336, enabled: true, ...body } });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string; token: string };
  };
  return { app, db, close, built, base: `127.0.0.1:${port}`, cookie, companyId, reg, addWorker };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const workerUrl = () => `ws://${ctx.base}/api/check-worker/connect`;
const status = (url: string, token: string) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
  });

function workerConn(token: string, commands: unknown[] = [], features: readonly string[] = WORKER_FEATURES) {
  return new RunnerConnection({ url: workerUrl(), token, runnerVersion: "test", heartbeatMs: HEARTBEAT, imageCommit: COMMIT, onCommand: (c) => void commands.push(c), runningChecks: () => [], checkWorker: { slots: 3, features } });
}

describe("check worker socket (BOS-1435)", () => {
  it("owner-only routes: no session gets 401; the token is answered once and only its hash is kept", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/api/settings/check-workers" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/api/settings/check-workers", payload: { name: "x", companyIds: [], slots: 1, checkThreads: null, checkMemoryMb: null, enabled: true } })).statusCode).toBe(401);
    const { id, token } = await ctx.addWorker();
    expect(token).toMatch(/^bmw_/);
    const row = (await ctx.db.select().from(checkWorkers).where(eq(checkWorkers.id, id)))[0]!;
    expect(JSON.stringify(row)).not.toContain(token);
    const listed = (await ctx.app.inject({ method: "GET", url: "/api/settings/check-workers", headers: { cookie: ctx.cookie } })).json();
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(listed[0]).toMatchObject({ id, name: "Hall NAS", slots: 2, checkThreads: 4, checkMemoryMb: 14336 });
    // Out-of-range values are refused.
    const bad = await ctx.app.inject({ method: "POST", url: "/api/settings/check-workers", headers: { cookie: ctx.cookie }, payload: { name: "x", companyIds: [], slots: 99, checkThreads: null, checkMemoryMb: null, enabled: true } });
    expect(bad.statusCode).toBe(400);
  });

  it("a worker token opens only the worker socket; a runner token doesn't open it", async () => {
    const { token } = await ctx.addWorker();
    expect(await status(`ws://${ctx.base}/api/runner/connect`, token)).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/runner/env?purpose=merge", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/runner/env", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect(await status(workerUrl(), ctx.reg.token)).toBe(401);
    expect(await status(workerUrl(), "bmw_nope")).toBe(401);
    expect(await status(workerUrl(), token)).toBe(101);
  });

  it("a worker connects, says its slots and commit in hello, and shows as connected without taking checks (no bundle support yet)", async () => {
    const { id, token } = await ctx.addWorker();
    // An image from before BOS-1436: it can run checks but not fetch their code.
    const conn = workerConn(token, [], ["check-jobs"]);
    conn.start();
    try {
      await waitFor(() => conn.isLive, Boolean);
      const view = await waitFor(
        async () => (await ctx.app.inject({ method: "GET", url: "/api/settings/check-queue", headers: { cookie: ctx.cookie } })).json(),
        (v) => v.workers?.[0]?.connected === true,
      );
      expect(view.workers[0]).toMatchObject({ id, connected: true, reportedSlots: 3, limit: 2, imageCommit: COMMIT });
      expect(view.workers[0].reason).toMatch(/can't fetch the code/);
    } finally {
      conn.stop();
    }
  });

  it("refuses anything but check messages: journal events and request replies get an error and are dropped", async () => {
    const { token } = await ctx.addWorker();
    const ws = new WebSocket(workerUrl(), { headers: { authorization: `Bearer ${token}` } });
    const got: Array<{ type: string; message?: string }> = [];
    ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, runnerVersion: "t", imageVersion: null, features: ["check-jobs"] }));
    await waitFor(() => got.some((m) => m.type === "welcome"), Boolean);
    ws.send(JSON.stringify({ type: "event", entry: { seq: 1, at: new Date().toISOString(), event: { type: "runner.log", level: "info", message: "x" } } }));
    ws.send(JSON.stringify({ type: "reply", requestId: "r1", ok: true, data: { env: {} } }));
    await waitFor(() => got.filter((m) => m.type === "error").length, (n) => n >= 2);
    expect(got.filter((m) => m.type === "error").every((m) => m.message === "Not a check worker message")).toBe(true);
    expect(got.some((m) => m.type === "ack")).toBe(false);
    ws.close();
  });

  it("turning a worker off closes its socket and refuses the redial; removing it makes the token unknown", async () => {
    const { id, token } = await ctx.addWorker();
    const ws = new WebSocket(workerUrl(), { headers: { authorization: `Bearer ${token}` } });
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    const welcomed = new Promise((r) => ws.on("message", (raw) => JSON.parse(String(raw)).type === "welcome" && r(true)));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, runnerVersion: "t", imageVersion: null, features: ["check-jobs"] }));
    await welcomed;
    const off = await ctx.app.inject({ method: "PATCH", url: `/api/settings/check-workers/${id}`, headers: { cookie: ctx.cookie }, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(await closed).toBe(4003);
    expect(await status(workerUrl(), token)).toBe(403);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/settings/check-workers/${id}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(200);
    expect(await status(workerUrl(), token)).toBe(401);
  });
});
