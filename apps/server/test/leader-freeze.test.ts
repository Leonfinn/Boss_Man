// BOS-432: a freeze of this server must not make the leader step down. The live server froze for 4-11 s; pg's
// query_timeout is a plain timer, so after the freeze it fired before the (long since arrived) heartbeat reply was
// read, the leader stepped down and every runner socket was closed.
//
// These run without a real Postgres: a small wire-protocol server in a worker thread (helpers/fake-pg-worker.mjs)
// stands in for it, and keeps answering on its own event loop while the test blocks the main thread.
import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { performance } from "node:perf_hooks";
import { createLeader, MAX_OUTSTANDING_MS, withinFairTime, type Leader } from "../src/leader.js";

type FakePg = { url: string; set(mode: "normal" | "hang" | "trap" | "kill"): void; freezeDuringHeartbeat(ms: number): Promise<void>; close(): Promise<number> };

/** Blocks this thread, like a long GC pause or a synchronous job would. */
const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

async function fakePg(): Promise<FakePg> {
  const flag = new SharedArrayBuffer(4);
  const worker = new Worker(new URL("./helpers/fake-pg-worker.mjs", import.meta.url), { workerData: { flag } });
  const port = await new Promise<number>((resolve, reject) => {
    worker.once("message", (m: { port: number }) => resolve(m.port));
    worker.once("error", reject);
  });
  const f = new Int32Array(flag);
  return {
    url: `postgres://bm:bm@127.0.0.1:${port}/bm`,
    set: (mode) => worker.postMessage({ mode }),
    // Wait until a heartbeat query has reached the fake (it answers 300 ms later, while we are frozen), then freeze.
    async freezeDuringHeartbeat(ms) {
      Atomics.store(f, 0, 0);
      worker.postMessage({ mode: "trap" });
      for (const end = Date.now() + 5000; Atomics.load(f, 0) === 0; await new Promise((r) => setTimeout(r, 5))) {
        if (Date.now() > end) throw new Error("no heartbeat reached the fake Postgres");
      }
      block(ms);
    },
    close: () => worker.terminate(),
  };
}

async function waitFor(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function leaderOn(o: Parameters<typeof createLeader>[0] = {}) {
  const pg = await fakePg();
  cleanup.push(() => pg.close());
  const logs: string[] = [];
  const leader = createLeader({ url: pg.url, intervalMs: 100, log: (m) => logs.push(m), ...o });
  cleanup.push(() => leader.stop());
  let demotions = 0;
  leader.onDemote(() => void demotions++);
  await leader.start();
  expect(leader.role()).toBe("leader");
  return { pg, leader, logs, demotions: () => demotions };
}

// BOS-1940: the two freeze tests ran a 5 s freeze against the default 3 s deadline (about 12 s of this file's 19 s).
// They now freeze 2 s against a 1 s deadline. What they catch is the same: a freeze longer than the heartbeat's
// deadline, ending after the reply (sent 300 ms into the freeze) has arrived. On the BOS-432 code, a plain timer,
// that read as a miss. The heartbeat's timer now fires ~1 s late, past leader.ts's LATE_MS (500), so it re-arms.
const DEADLINE_MS = 1000;
const FREEZE_MS = 2000;

describe("leader heartbeat and server freezes (BOS-432)", () => {
  it("a freeze twice the heartbeat deadline, while a heartbeat waits for its reply, does not demote the leader", async () => {
    const { pg, leader, logs, demotions } = await leaderOn({ queryTimeoutMs: DEADLINE_MS });
    await pg.freezeDuringHeartbeat(FREEZE_MS);
    await sleep(500);
    expect(logs.filter((l) => l.includes("STANDBY"))).toEqual([]);
    expect([leader.role(), demotions()]).toEqual(["leader", 0]);
  });

  it("no reply at all: one miss is tolerated, the second steps down", async () => {
    const { pg, leader, logs, demotions } = await leaderOn({ queryTimeoutMs: 300 });
    // The fake Postgres still grants the lock while it holds heartbeats back, so a stepped-down leader would win it
    // again and cycle on. End the hang in the step-down itself (not by polling, which a busy machine delays), so
    // exactly one cycle is observed however late the test thread runs (BOS-505).
    leader.onDemote(() => pg.set("normal"));
    pg.set("hang");
    await waitFor(() => demotions() > 0); // not isLeader(): it may already have won the lock back
    expect(demotions()).toBe(1);
    // Judged from the log order, not by polling between the misses, so a busy machine can't make it flaky.
    const at = (s: string) => logs.findIndex((l) => l.includes(s));
    expect(at("heartbeat miss 1 of 2")).toBeGreaterThan(-1);
    expect(at("heartbeat miss 2 of 2")).toBeGreaterThan(at("heartbeat miss 1 of 2"));
    expect(at("STANDBY (no heartbeat reply 2 time(s) in a row)")).toBeGreaterThan(at("heartbeat miss 2 of 2"));
    expect(logs.filter((l) => l.includes("STANDBY"))).toHaveLength(1);
  });

  it("a reply after one miss clears it", async () => {
    const { pg, leader, logs } = await leaderOn({ queryTimeoutMs: 1500 });
    pg.set("hang");
    await waitFor(() => logs.some((l) => l.includes("heartbeat miss 1 of 2")));
    pg.set("normal"); // the held reply arrives late
    await waitFor(() => logs.some((l) => l.includes("heartbeat answered again after 1 miss(es)")));
    await sleep(1000);
    expect(leader.isLeader()).toBe(true);
    expect(logs.some((l) => l.includes("heartbeat miss 2 of 2"))).toBe(false);
  });

  it("BOSSMAN_LEADER_MISSES=1 keeps the old behaviour: the first miss steps down", async () => {
    const { pg, leader, logs } = await leaderOn({ queryTimeoutMs: 300, maxMisses: 1 });
    pg.set("hang");
    await waitFor(() => !leader.isLeader());
    expect(logs.some((l) => l.includes("heartbeat miss 1 of 1"))).toBe(true);
  });

  it("a dropped connection still steps down at once, not after two misses", async () => {
    const { pg, leader, logs } = await leaderOn({ queryTimeoutMs: 5000 });
    const started = Date.now();
    pg.set("kill");
    await waitFor(() => !leader.isLeader(), 4000);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(logs.some((l) => l.includes("lost the lock connection"))).toBe(true);
    expect(logs.some((l) => l.includes("heartbeat miss"))).toBe(false);
  });

  it("a test server frozen for twice the heartbeat deadline keeps the lead and its runner socket, and server_status shows the stall", async () => {
    const pg = await fakePg();
    cleanup.push(() => pg.close());
    const leader = createLeader({ url: pg.url, intervalMs: 100, queryTimeoutMs: DEADLINE_MS });
    const { db, close } = await openPglite();
    cleanup.push(close);
    const { app, serverStatus } = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, leader });
    cleanup.push(() => app.close());
    cleanup.push(() => leader.stop());
    await leader.start();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${setup.cookies.find((c) => c.name === "bm_session")!.value}`;
    const companyId = (await app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "Co" } })).json().company.id as string;
    const token = (await app.inject({ method: "POST", url: `/api/companies/${companyId}/runner`, headers: { cookie } })).json().token as string;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runner/connect`, { headers: { authorization: `Bearer ${token}` } });
    await new Promise((r) => ws.on("open", r));
    let closedWith: number | null = null;
    ws.on("close", (code) => (closedWith = code));
    cleanup.push(async () => ws.close());

    await pg.freezeDuringHeartbeat(FREEZE_MS);
    await sleep(800);

    expect(leader.role()).toBe("leader");
    expect(closedWith).toBeNull();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect((await app.inject({ method: "GET", url: "/api/health" })).json().role).toBe("leader");

    const stalls = (await serverStatus.status(companyId)).stalls!;
    expect(stalls.count).toBeGreaterThanOrEqual(1);
    const worst = stalls.recent.reduce((a, b) => (b.ms > a.ms ? b : a));
    expect(worst.ms).toBeGreaterThan(FREEZE_MS - 500); // and over the stall monitor's 1 s floor
    expect(worst.memory.heapUsedMb).toBeGreaterThan(0);
    expect(worst.memory.rssMb).toBeGreaterThan(0);
    expect(worst.runnerSockets).toBe(1);
    expect(typeof worst.inFlight).toBe("number");
  });
});

describe("withinFairTime (BOS-432)", () => {
  const never = new Promise<never>(() => {});
  it("a timer that fired late because of a freeze gives a fresh window, not a timeout", async () => {
    let lates = 0;
    const p = withinFairTime(never, 200, () => void lates++);
    p.catch(() => {});
    block(1000);
    await sleep(100);
    expect(lates).toBe(1);
    await expect(p).rejects.toThrow(/no reply in 200 ms/); // the fresh window has no freeze in it
  });

  it("but never past the wall-clock cap, so a stale leader can't outlive Postgres's idle_session_timeout", async () => {
    let lates = 0;
    const p = withinFairTime(never, 200, () => void lates++, performance.now() - (MAX_OUTSTANDING_MS - 100));
    p.catch(() => {});
    block(1000);
    await expect(p).rejects.toThrow(/no reply/);
    expect(lates).toBe(0);
    expect(MAX_OUTSTANDING_MS).toBeLessThan(30_000 / 2 + 1); // idle_session_timeout is 30 s
  });
});
