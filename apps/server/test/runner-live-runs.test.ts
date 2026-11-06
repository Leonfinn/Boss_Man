// The runner lists its live runs in hello; the server closes any open run it leaves out (BOS-583).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Journal, RunnerConnection } from "@boss-man/runner";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, runs, wakes } from "../src/db/schema.js";

const HEARTBEAT = 100;
const OLD = () => new Date(Date.now() - 10 * 60_000);

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
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
  built.runners.setLiveRunsDelay(50);
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (built.app.server.address() as { port: number }).port;
  const setupRes = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${setupRes.cookies.find((c) => c.name === "bm_session")!.value}`;
  const companyId = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json().company.id as string;
  const reg = (await built.app.inject({ method: "POST", url: `/api/companies/${companyId}/runner`, headers: { cookie } })).json() as { runnerId: string; token: string };
  const agent = (await db.select().from(agents).where(eq(agents.companyId, companyId)))[0]!;
  return { app: built.app, built, db, close, url: `ws://127.0.0.1:${port}/api/runner/connect`, companyId, reg, agent };
}
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

function connect(liveRuns?: string[]) {
  const journal = new Journal(path.join(mkdtempSync(path.join(tmpdir(), "bm-runner-")), "j.jsonl"));
  const conn = new RunnerConnection({ url: ctx.url, token: ctx.reg.token, journal, runnerVersion: "test", heartbeatMs: HEARTBEAT, onCommand: () => {}, ...(liveRuns ? { liveRuns: () => liveRuns } : {}) });
  conn.start();
  return conn;
}
const open = async (startedAt = OLD()) => {
  const id = randomUUID();
  await ctx.db.insert(runs).values({ id, companyId: ctx.companyId, agentId: ctx.agent.id, startedAt, lastEventAt: startedAt });
  return id;
};
const outcome = async (id: string) => (await ctx.db.select().from(runs).where(eq(runs.id, id)))[0]!.outcome;

describe("runner lists its live runs in hello (BOS-583)", () => {
  it("closes the open run the list leaves out, resumes it, and keeps the listed and the just-started ones", async () => {
    const [a, b, c] = [await open(), await open(), await open()];
    const fresh = await open(new Date());
    const conn = connect([a, b]);
    expect(await waitFor(() => outcome(c), (o) => !!o)).toBe("lost: runner doesn't have it");
    await waitFor(async () => (await ctx.db.select().from(wakes)).filter((w) => w.resumeRunId === c), (w) => w.length === 1);
    expect(await outcome(a)).toBeNull();
    expect(await outcome(b)).toBeNull();
    expect(await outcome(fresh)).toBeNull();
    conn.stop();
  });

  it("an old runner that sends no list closes nothing", async () => {
    const [a, c] = [await open(), await open()];
    const conn = connect();
    await waitFor(async () => conn.isLive, Boolean);
    await new Promise((r) => setTimeout(r, 600));
    expect(await outcome(a)).toBeNull();
    expect(await outcome(c)).toBeNull();
    expect(await ctx.db.select().from(wakes).where(eq(wakes.reason, "resume"))).toHaveLength(0);
    conn.stop();
  });
});
