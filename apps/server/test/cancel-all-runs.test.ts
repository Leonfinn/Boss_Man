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
});
