// BOS-837: the owner's "End all running runs" button. It ends every run going now, in every company,
// through the per-run cancel (so an offline runner is handled the same way as a single cancel), returns
// how many it ended, and is the owner's alone: an agent run token is refused.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners, runs } from "../src/db/schema.js";
import { RunError } from "../src/services/runs.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

/** A company with a runner and one live run on it, plus a "connect" that records every command sent to that runner. */
type Company = { id: string; ceo: { id: string }; worker: { id: string }; runnerId: string; runId: string };

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const sent: RunnerCommand[] = [];
  const releases: Array<() => void> = [];

  // One company, its CEO and worker, a registered runner, and one live run, which the scheduler starts.
  async function company(name: string): Promise<Company> {
    const { company, ceo } = (await req("POST", "/api/companies", { name })).json() as { company: { id: string }; ceo: { id: string } };
    const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
    const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
    releases.push(built.runners.connect(reg.runnerId, (c) => (sent.push(c), true)));
    const from = sent.length;
    await built.scheduler.wake({ agentId: worker.id, reason: "start" });
    await built.scheduler.tick();
    const start = sent.slice(from).find((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
    if (!start) throw new Error(`no run started for ${name}`);
    return { id: company.id, ceo, worker, runnerId: reg.runnerId, runId: start.runId };
  }

  return { ...built, db, close, req, sent, releases, company, base, cookie };
}

const runRow = async (db: Awaited<ReturnType<typeof setup>>["db"], id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;

describe("ending all running runs (BOS-837)", () => {
  it("cancels all three live runs in two companies through the per-run cancel, and returns 3", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co");
    const b = await c.company("Web Co");
    // A second live run in the first company, on its CEO.
    const from = c.sent.length;
    await c.scheduler.wake({ agentId: a.ceo.id, reason: "start" });
    await c.scheduler.tick();
    const second = c.sent.slice(from).find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start")!;
    const live = [a.runId, b.runId, second.runId];

    const res = await c.req("POST", "/api/runs/cancel-all");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelled: 3 });
    // Every live run got the same run.cancel the single stop sends.
    for (const id of live) expect(c.sent).toContainEqual({ type: "run.cancel", runId: id });
    expect(c.sent.filter((x) => x.type === "run.cancel")).toHaveLength(3);
    // The cancel is waiting for the runner's own run.ended, as it does for one run.
    for (const id of live) expect((await runRow(c.db, id)).cancelRequestedAt).not.toBeNull();
  });

  it("ends the runs of a runner that is offline here, the same way a single cancel does", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co");
    // The runner that went away: nothing can confirm, so the server ends the run itself.
    for (const release of c.releases) release();
    expect((await c.req("POST", "/api/runs/cancel-all")).json()).toEqual({ cancelled: 1 });
    const after = await runRow(c.db, a.runId);
    expect(after.endedAt).not.toBeNull();
    expect(after.outcome).toBe("stopped: runner offline");
  });

  it("refuses an agent run token", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co");
    const token = await issueRunToken(c.db, { companyId: a.id, agentId: a.worker.id, runId: a.runId });
    const agent = new Client({ name: "t", version: "0" });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`http://${c.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      // The agent's only door is MCP, and it has no way to end every run.
      const tools = (await agent.listTools()).tools.map((t) => t.name);
      expect(tools).not.toContain("cancel_all_runs");
      expect(tools).toContain("runs");
      const res = await agent.callTool({ name: "runs", arguments: { action: "list" } });
      expect((res as { isError?: boolean }).isError).toBe(true);
    } finally {
      await agent.close();
    }
    // The owner's own call is the only one: the agent's token on it is not a session cookie.
    const asAgent = await c.app.inject({ method: "POST", url: "/api/runs/cancel-all", headers: { authorization: `Bearer ${token}` } });
    expect(asAgent.statusCode).toBe(401);
    expect(asAgent.json()).toEqual({ error: "not_signed_in" });
    // Nothing was cancelled by either attempt.
    expect((await runRow(c.db, a.runId)).cancelRequestedAt).toBeNull();
    expect((await runRow(c.db, a.runId)).endedAt).toBeNull();
  });

  it("refuses a request without the owner session", async () => {
    const c = (ctx = await setup());
    await c.company("App Co");
    const anon = await c.app.inject({ method: "POST", url: "/api/runs/cancel-all" });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ error: "not_signed_in" });
  });

  it("returns 0 with no live run, and leaves finished and already-cancelled runs exactly as they were", async () => {
    const c = (ctx = await setup());
    // No company at all: nothing live, and the call answers rather than failing on an empty list.
    expect((await c.req("POST", "/api/runs/cancel-all")).json()).toEqual({ cancelled: 0 });

    const a = await c.company("App Co");
    // One run that has finished, and one already cancelled: neither is live, and neither is touched.
    const finished = crypto.randomUUID();
    const stopped = crypto.randomUUID();
    await c.db.insert(runs).values({ id: finished, companyId: a.id, agentId: a.worker.id, startedAt: new Date(Date.now() - 60_000), endedAt: new Date(Date.now() - 30_000), outcome: "end_turn" });
    await c.db.insert(runs).values({ id: stopped, companyId: a.id, agentId: a.worker.id, startedAt: new Date(Date.now() - 60_000), endedAt: new Date(Date.now() - 30_000), outcome: "stopped: runner offline" });
    const beforeFinished = await runRow(c.db, finished);
    const beforeStopped = await runRow(c.db, stopped);
    const cancelsBefore = c.sent.filter((x) => x.type === "run.cancel").length;

    // The one live run ends, so the call has one to do; the two old rows are left exactly as they were.
    expect((await c.req("POST", "/api/runs/cancel-all")).json()).toEqual({ cancelled: 1 });
    expect(c.sent.filter((x) => x.type === "run.cancel").length).toBe(cancelsBefore + 1);
    expect(c.sent.filter((x) => x.type === "run.cancel" && x.runId === finished)).toHaveLength(0);
    expect(c.sent.filter((x) => x.type === "run.cancel" && x.runId === stopped)).toHaveLength(0);
    expect(await runRow(c.db, finished)).toEqual(beforeFinished);
    expect(await runRow(c.db, stopped)).toEqual(beforeStopped);

    // A second call with nothing live ends nothing. (The runner hasn't confirmed the first cancel yet, so
    // the run's own row still reads live until it does, as the single cancel does too.)
    const live = await c.db.select().from(runs).where(and(eq(runs.companyId, a.id), isNull(runs.endedAt)));
    expect(live.map((r) => r.id)).toEqual([a.runId]);
    expect(live[0]!.cancelRequestedAt).not.toBeNull();
    expect((await c.req("POST", "/api/runs/cancel-all")).json()).toEqual({ cancelled: 1 });
  });

  it("keeps going when one cancel throws, ending the rest, and returns and logs the one it could not end", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co");
    const b = await c.company("Web Co");
    // A failed cancel is a dancer's send throwing, or a database error; here the runner's socket throws for one run.
    // The others, before and after it, must still be cancelled: this is the emergency stop (BOS-862).
    // A second live run in the first company, so one throwing run is not the whole list.
    const from = c.sent.length;
    await c.scheduler.wake({ agentId: a.ceo.id, reason: "start" });
    await c.scheduler.tick();
    const second = c.sent.slice(from).find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start")!;

    // The runner's call throws for one run's cancel, as a closed socket or a database error can. Put that run in
    // the middle of the list so the one after it proves the loop went on.
    const broken = second.runId;
    c.releases[0]!();
    c.releases.push(
      c.runners.connect(a.runnerId, (command) => {
        if (command.type === "run.cancel" && command.runId === broken) throw new Error("socket is closed");
        c.sent.push(command);
        return true;
      }),
    );
    // The list comes off the table unordered, so sort it so the broken run is not first.
    await c.db.update(runs).set({ startedAt: new Date(Date.now() - 60_000) }).where(eq(runs.id, broken));

    const logs: string[] = [];
    const off = c.app.log.error;
    c.app.log.error = ((...args: Parameters<typeof off>) => (logs.push(String(args[0])), off(...args))) as typeof c.app.log.error;
    try {
      const res = await c.req("POST", "/api/runs/cancel-all");
      expect(res.statusCode).toBe(200);
      const body = res.json() as { cancelled: number; failed: string[] };
      expect(body.cancelled).toBe(2);
      expect(body.failed).toEqual([broken]);
      // The other two got their cancel; the broken one did not stop the loop.
      expect(c.sent).toContainEqual({ type: "run.cancel", runId: a.runId });
      expect(c.sent).toContainEqual({ type: "run.cancel", runId: b.runId });
      expect((await runRow(c.db, a.runId)).cancelRequestedAt).not.toBeNull();
      expect((await runRow(c.db, b.runId)).cancelRequestedAt).not.toBeNull();
      // The run it could not end is still live, so the owner can open it and stop it themselves.
      expect((await runRow(c.db, broken)).endedAt).toBeNull();
      expect((await runRow(c.db, broken)).cancelRequestedAt).toBeNull();
      // The failure is logged with the run id and the error's message.
      expect(logs.some((l) => l.includes(broken) && l.includes("socket is closed"))).toBe(true);
    } finally {
      c.app.log.error = off;
    }
  });

  it("skips a run that ended on its own during the loop, counting it in neither number", async () => {
    const c = (ctx = await setup());
    const a = await c.company("App Co");
    const b = await c.company("Web Co");
    // A second live run in the first company, on its CEO.
    const from = c.sent.length;
    await c.scheduler.wake({ agentId: a.ceo.id, reason: "start" });
    await c.scheduler.tick();
    const selfEnds = c.sent.slice(from).find((x): x is Extract<RunnerCommand, { type: "run.start" }> => x.type === "run.start")!;

    // The run ends on its own between the list and its cancel (its agent finished). The per-run cancel it then
    // sees throws a 409, which is not a failure: it must be skipped and counted in neither number, and not logged
    // as one that could not be ended (BOS-862). A 409 from the real cancel is the same shape as this.
    const offCancel = c.runs.cancel;
    const realCancel = offCancel.bind(c.runs);
    c.runs.cancel = ((runId: string, companyId?: string, reason?: string) =>
      runId === selfEnds.runId ? Promise.reject(new RunError(409, "That run has already ended.")) : realCancel(runId, companyId, reason)) as typeof offCancel;

    const logs: string[] = [];
    const off = c.app.log.error;
    c.app.log.error = ((...args: Parameters<typeof off>) => (logs.push(String(args[0])), off(...args))) as typeof c.app.log.error;
    try {
      const res = await c.req("POST", "/api/runs/cancel-all");
      expect(res.statusCode).toBe(200);
      // The two other live runs were ended; the one that had ended itself is counted in neither number.
      expect(res.json()).toEqual({ cancelled: 2 });
      expect((await runRow(c.db, a.runId)).cancelRequestedAt).not.toBeNull();
      expect((await runRow(c.db, b.runId)).cancelRequestedAt).not.toBeNull();
      // A 409 is expected housekeeping, not a failure: nothing is logged as could-not-end.
      expect(logs.some((l) => l.includes(selfEnds.runId))).toBe(false);
    } finally {
      c.runs.cancel = offCancel;
      c.app.log.error = off;
    }
  });
});
