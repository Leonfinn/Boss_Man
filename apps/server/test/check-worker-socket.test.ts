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
import { checkJobs, checkWorkers, projects, runners, settings, tickets } from "../src/db/schema.js";
import { CHECK_QUEUE_MODE_KEY, CHECK_SLOTS_KEY, checkQueue } from "../src/services/check-queue.js";
import { BUNDLE_FEATURE, WORKER_REPLACED_CLOSE } from "../src/services/check-workers.js";
import { WORKER_NO_HELLO_CLOSE } from "../src/routes/check-worker-socket.js";

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

function workerConn(token: string, commands: unknown[] = []) {
  return new RunnerConnection({ url: workerUrl(), token, runnerVersion: "test", heartbeatMs: HEARTBEAT, imageCommit: COMMIT, onCommand: (c) => void commands.push(c), runningChecks: () => [], checkWorker: { slots: 3, features: WORKER_FEATURES } });
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
    const conn = workerConn(token);
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

  /** A raw worker socket that says hello as a ready worker (bundle support, the runner's commit) and records what it gets. */
  async function readyWorker(token: string) {
    const ws = new WebSocket(workerUrl(), { headers: { authorization: `Bearer ${token}` } });
    const got: Array<{ type: string; command?: { type: string; jobId: string } }> = [];
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, runnerVersion: "t", imageVersion: null, imageCommit: COMMIT, checkSlots: 2, features: ["check-jobs", BUNDLE_FEATURE] }));
    await waitFor(() => got.some((m) => m.type === "welcome"), Boolean);
    return { ws, got, closed, runs: () => got.filter((m) => m.command?.type === "check.run").map((m) => m.command!.jobId) };
  }

  it("removing a busy worker puts its checks back in line, not back on the worker it is removing (Freddy's BOS-1435 find)", async () => {
    // The company runner is offline, so the worker is the only machine; before the fix, the pump inside the re-queue handed
    // the job straight back to the worker, and deleting the row then left it running with no machine at all.
    const { db } = ctx;
    await db.update(runners).set({ imageCommit: COMMIT }).where(eq(runners.id, ctx.reg.runnerId));
    for (const [key, value] of [[CHECK_QUEUE_MODE_KEY, "server"], [CHECK_SLOTS_KEY, 1]] as const)
      await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    const [p] = await db.insert(projects).values({ companyId: ctx.companyId, name: "Dev" }).returning();
    const [t] = await db.insert(tickets).values({ companyId: ctx.companyId, projectId: p!.id, title: "T", number: 1 }).returning();
    const { job } = await checkQueue(db).enqueue({ companyId: ctx.companyId, projectId: p!.id, ticketId: t!.id, kind: "pre_review", scope: "quick", commit: "c1000000", tree: "tree-1" } as never);
    const { id, token } = await ctx.addWorker();
    const w = await readyWorker(token);
    await waitFor(w.runs, (r) => r.includes(job.id));
    expect((await ctx.db.select().from(checkJobs).where(eq(checkJobs.id, job.id)))[0]).toMatchObject({ state: "running", workerId: id });
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/settings/check-workers/${id}`, headers: { cookie: ctx.cookie } })).statusCode).toBe(200);
    expect((await ctx.db.select().from(checkJobs).where(eq(checkJobs.id, job.id)))[0]).toMatchObject({ state: "queued", workerId: null, runnerId: null, reason: expect.stringMatching(/removed the check worker/) });
    expect(w.got.some((m) => m.command?.type === "check.cancel" && m.command.jobId === job.id)).toBe(true);
    expect(w.runs()).toEqual([job.id]); // sent once, never again
    expect(await w.closed).toBe(4003);
  });

  it("a second machine with the same token replaces the first, whose socket is closed", async () => {
    const { token } = await ctx.addWorker();
    const first = await readyWorker(token);
    const second = await readyWorker(token);
    expect(await first.closed).toBe(WORKER_REPLACED_CLOSE);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    // The first one going doesn't take the second's place in the connected list.
    const view = (await ctx.app.inject({ method: "GET", url: "/api/settings/check-queue", headers: { cookie: ctx.cookie } })).json();
    expect(view.workers[0].connected).toBe(true);
    second.ws.close();
  });

  it("closes a socket that never says hello within three heartbeats", async () => {
    const { token } = await ctx.addWorker();
    const ws = new WebSocket(workerUrl(), { headers: { authorization: `Bearer ${token}` } });
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    // Answers pings, so only the missing hello can close it.
    ws.on("message", (raw) => JSON.parse(String(raw)).type === "ping" && ws.send(JSON.stringify({ type: "pong" })));
    expect(await closed).toBe(WORKER_NO_HELLO_CLOSE);
  });
});
