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
import { createLeader, type Leader } from "../src/leader.js";

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
      if ((await Atomics.waitAsync(f, 0, 0, 5000).value) === "timed-out") throw new Error("no heartbeat reached the fake Postgres");
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

describe("leader heartbeat and server freezes (BOS-432)", () => {
  it("a 5 s freeze while a heartbeat waits for its reply does not demote the leader", async () => {
    const { pg, leader, logs, demotions } = await leaderOn(); // the default 3 s deadline, as on the live server
    await pg.freezeDuringHeartbeat(5000);
    await sleep(500);
    expect(logs.filter((l) => l.includes("STANDBY"))).toEqual([]);
    expect([leader.role(), demotions()]).toEqual(["leader", 0]);
  });

  it("no reply at all: one miss is tolerated, the second steps down", async () => {
    const { pg, leader, logs, demotions } = await leaderOn({ queryTimeoutMs: 300 });
    pg.set("hang");
    await waitFor(() => logs.some((l) => l.includes("heartbeat miss 1 of 2")));
    expect(leader.isLeader()).toBe(true);
    await waitFor(() => !leader.isLeader());
    expect(demotions()).toBe(1);
    expect(logs.some((l) => l.includes("STANDBY (no heartbeat reply 2 time(s) in a row)"))).toBe(true);
  });

  it("a reply after one miss clears it", async () => {
    const { pg, leader, logs } = await leaderOn({ queryTimeoutMs: 300 });
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
    const { pg, leader, logs } = await leaderOn({ queryTimeoutMs: 3000 });
    const started = Date.now();
    pg.set("kill");
    await waitFor(() => !leader.isLeader(), 2000);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(logs.some((l) => l.includes("lost the lock connection"))).toBe(true);
    expect(logs.some((l) => l.includes("heartbeat miss"))).toBe(false);
  });

  it("a test server frozen for 5 s keeps the lead and its runner socket, and server_status shows the stall", async () => {
    const pg = await fakePg();
    cleanup.push(() => pg.close());
    const leader = createLeader({ url: pg.url, intervalMs: 100 });
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

    await pg.freezeDuringHeartbeat(5000);
    await sleep(800);

    expect(leader.role()).toBe("leader");
    expect(closedWith).toBeNull();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect((await app.inject({ method: "GET", url: "/api/health" })).json().role).toBe("leader");

    const stalls = (await serverStatus.status(companyId)).stalls!;
    expect(stalls.count).toBeGreaterThanOrEqual(1);
    const worst = stalls.recent.reduce((a, b) => (b.ms > a.ms ? b : a));
    expect(worst.ms).toBeGreaterThan(4500);
    expect(worst.memory.heapUsedMb).toBeGreaterThan(0);
    expect(worst.memory.rssMb).toBeGreaterThan(0);
    expect(worst.runnerSockets).toBe(1);
    expect(typeof worst.inFlight).toBe("number");
  });
});
