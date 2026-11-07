import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners, runs, tickets } from "../src/db/schema.js";
import { dashboardService, runResult } from "../src/services/dashboard.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  const starts = () => sent.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  return { ...built, db, close, req, company, worker, project, sent, emit, starts };
}


describe("dashboard (R74)", () => {
  it("sorts how runs ended", () => {
    expect([runResult("end_turn"), runResult("error: rate limited"), runResult("interrupted"), runResult(null)]).toEqual(["succeeded", "failed", "other", "other"]);
  });

  it("shows what agents are doing, the headline numbers and the last 14 days", async () => {
    const c = (ctx = await setup());
    const a = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Fix login", assigneeAgentId: c.worker.id })).json() as { id: string };
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Blocked one", state: "blocked" });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Later" });
    await c.scheduler.tick();
    const run = c.starts()[0]!;
    let data = (await c.req("GET", `/api/companies/${c.company.id}/dashboard`)).json();
    expect(data.agents[0]).toMatchObject({ name: "Engineer", run: { id: run.runId, ticket: "Fix login", result: "running" } });
    expect(data.stats).toMatchObject({ agents: 3, running: 1, paused: 1, inProgress: 1, inReview: 0, open: 3, blocked: 1, decisionsWaiting: 0 });

    await c.emit({ type: "run.ended", runId: run.runId, stopReason: "end_turn", error: null });
    await c.decisions.raise({ companyId: c.company.id, agentId: null, question: "Which?", options: ["A", "B"], recommended: "A" });
    data = (await c.req("GET", `/api/companies/${c.company.id}/dashboard`)).json();
    expect(data.agents.find((x: { name: string }) => x.name === "Engineer").run.result).toBe("succeeded");
    expect(data.stats.decisionsWaiting).toBe(1);
    expect(data.runsByDay).toHaveLength(14);
    expect(data.runsByDay.at(-1)).toMatchObject({ succeeded: 1, failed: 0 });
    expect(data.ticketsByDay.at(-1)).toMatchObject({ in_progress: 1, blocked: 1, backlog: 1 });
    expect(data.recentTickets.map((t: { id: string }) => t.id)).toContain(a.id);
  });
  it("counts subscription use in tokens, and only API use as money spent", async () => {
    const c = (ctx = await setup());
    const sub = (await c.req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
    const payg = (await c.req("POST", "/api/funding-sources", { name: "API", kind: "api_payg", provider: "anthropic" })).json() as { id: string };
    await c.req("PATCH", `/api/agents/${c.worker.id}`, { fundingSourceId: sub.id });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Fix login", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const run = c.starts()[0]!;
    // A subscription run reports a list-price cost; it isn't money spent.
    await c.emit({ type: "run.cost", runId: run.runId, fundingSourceId: sub.id, costMicrosDelta: 5_000_000, model: "claude-opus-5-5" });
    await c.emit({ type: "run.ended", runId: run.runId, stopReason: "end_turn", error: null, usage: { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 0, cachedWriteTokens: 0 } });
    let stats = (await c.req("GET", `/api/companies/${c.company.id}/dashboard`)).json().stats;
    expect(stats).toMatchObject({ monthCostMicros: 0, monthSubscriptionTokens: { input: 1200, output: 300 }, monthSubscriptionRuns: 1, monthSubscriptionUnrecorded: 0 });

    // A pay-as-you-go run is money.
    await c.req("PATCH", `/api/agents/${c.worker.id}`, { fundingSourceId: payg.id });
    await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Another", assigneeAgentId: c.worker.id });
    await c.scheduler.tick();
    const second = c.starts().at(-1)!;
    await c.emit({ type: "run.cost", runId: second.runId, fundingSourceId: payg.id, costMicrosDelta: 2_500_000, model: "claude-opus-5-5" });
    stats = (await c.req("GET", `/api/companies/${c.company.id}/dashboard`)).json().stats;
    expect(stats).toMatchObject({ monthCostMicros: 2_500_000, monthSubscriptionRuns: 1 });
  });
  // BOS-672: the latest run comes from one index read per agent, and the day charts are counted in SQL by UTC day.
  it("picks each agent's newest run and counts runs on the UTC day they ended", async () => {
    const c = (ctx = await setup());
    const now = new Date("2026-11-07T00:30:00Z");
    const at = (iso: string) => new Date(iso);
    await c.db.insert(runs).values([
      { companyId: c.company.id, agentId: c.worker.id, startedAt: at("2026-11-06T23:00:00Z"), endedAt: at("2026-11-06T23:59:59Z"), outcome: "error: boom" },
      { companyId: c.company.id, agentId: c.worker.id, startedAt: at("2026-11-07T00:00:00Z"), endedAt: at("2026-11-07T00:00:01Z"), outcome: "end_turn" },
      { companyId: c.company.id, agentId: c.worker.id, startedAt: at("2026-11-05T10:00:00Z"), endedAt: at("2026-11-05T11:00:00Z"), outcome: "interrupted" },
      // Ended before the 14-day window: not on the chart.
      { companyId: c.company.id, agentId: c.worker.id, startedAt: at("2026-10-01T10:00:00Z"), endedAt: at("2026-10-01T11:00:00Z"), outcome: "end_turn" },
    ]);
    const data = await dashboardService(c.db, { now: () => now }).get(c.company.id);
    expect(data.agents.find((a) => a.name === "Engineer")!.run).toMatchObject({ result: "succeeded", startedAt: at("2026-11-07T00:00:00Z") });
    expect(data.runsByDay.slice(-3)).toEqual([
      { day: "2026-11-05", succeeded: 0, failed: 0, other: 1 },
      { day: "2026-11-06", succeeded: 0, failed: 1, other: 0 },
      { day: "2026-11-07", succeeded: 1, failed: 0, other: 0 },
    ]);
    expect(data.runsByDay.reduce((n, d) => n + d.succeeded + d.failed + d.other, 0)).toBe(3);
  });
  it("shows a ticket under its state, even when its column was left behind by an older move", async () => {
    const c = (ctx = await setup());
    const t = (await c.req("POST", `/api/projects/${c.project.id}/tickets`, { title: "Research" })).json() as { id: string };
    // Before #49, an agent's set_ticket_state changed the state but not the column.
    await c.db.update(tickets).set({ systemState: "review" }).where(eq(tickets.id, t.id));
    const board = (await c.req("GET", `/api/projects/${c.project.id}/board`)).json() as { columns: Array<{ systemState: string; tickets: Array<{ id: string }> }> };
    expect(board.columns.find((col) => col.systemState === "review")!.tickets.map((x) => x.id)).toEqual([t.id]);
    expect(board.columns.find((col) => col.systemState === "backlog")!.tickets).toEqual([]);
    expect((await c.req("GET", `/api/companies/${c.company.id}/dashboard`)).json().stats).toMatchObject({ inProgress: 0, inReview: 1 });
  });
});
