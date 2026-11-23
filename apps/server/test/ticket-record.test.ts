import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, checkWorkers, costEvents, fundingSources, projects, runners as runnersT, runs, tickets } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const [t] = await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Add rate limiting", systemState: "in_progress" }).returning();
  return { ...built, db, close, req, co, project, dev, ticketId: t!.id };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

describe("ticket record (BOS-2175)", () => {
  it("is empty for a ticket nothing has happened on", async () => {
    const res = await ctx.req("GET", `/api/tickets/${ctx.ticketId}/record`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runs: { total: 0, errored: 0 }, spendMicros: 0, capMicros: null, lastCheck: null });
  });

  it("counts runs and errors, sums spend, and reports the cap and the last finished check", async () => {
    const co = ctx.co.company.id;
    const [src] = await ctx.db.insert(fundingSources).values({ name: "Key", kind: "subscription", provider: "anthropic" }).returning();
    const mk = (outcome: string) => ctx.db.insert(runs).values({ companyId: co, agentId: ctx.dev.id, ticketId: ctx.ticketId, outcome, endedAt: new Date() }).returning();
    const [a] = await mk("end_turn");
    const [b] = await mk("error: boom");
    for (const [run, micros] of [[a, 1_500_000], [b, 500_000]] as const) {
      await ctx.db.insert(costEvents).values({ runId: run!.id, fundingSourceId: src!.id, companyId: co, costMicros: micros });
    }
    await ctx.db.update(tickets).set({ costCapMicros: 5_000_000 }).where(eq(tickets.id, ctx.ticketId));
    const base = { companyId: co, projectId: ctx.project.id, ticketId: ctx.ticketId, kind: "merge", commit: "c", tree: "t" };
    await ctx.db.insert(checkJobs).values({ ...base, state: "failed", endedAt: new Date(Date.now() - 60_000) });
    await ctx.db.insert(checkJobs).values({ ...base, state: "passed", scope: "quick", endedAt: new Date() });
    await ctx.db.insert(checkJobs).values({ ...base, state: "running" });

    const body = (await ctx.req("GET", `/api/tickets/${ctx.ticketId}/record`)).json();
    expect(body).toMatchObject({ runs: { total: 2, errored: 1 }, spendMicros: 2_000_000, capMicros: 5_000_000, lastCheck: { result: "pass", scope: "quick" } });
  });

  it("falls back to the project's cap and answers 404 for an unknown ticket", async () => {
    await ctx.db.update(projects).set({ ticketCostCapMicros: 3_000_000 }).where(eq(projects.id, ctx.project.id));
    expect((await ctx.req("GET", `/api/tickets/${ctx.ticketId}/record`)).json().capMicros).toBe(3_000_000);
    expect((await ctx.req("GET", `/api/tickets/${crypto.randomUUID()}/record`)).statusCode).toBe(404);
  });
});

describe("ticket checks list (BOS-2371)", () => {
  it("is empty for a ticket with no checks, and 404 for an unknown ticket", async () => {
    expect((await ctx.req("GET", `/api/tickets/${ctx.ticketId}/checks`)).json()).toEqual({ checks: [] });
    expect((await ctx.req("GET", `/api/tickets/${crypto.randomUUID()}/checks`)).statusCode).toBe(404);
  });

  it("lists every check newest first with what, machine and the first failing line", async () => {
    const co = ctx.co.company.id;
    const [worker] = await ctx.db.insert(checkWorkers).values({ name: "Big box", tokenHash: "h1" }).returning();
    const [runner] = await ctx.db.insert(runnersT).values({ companyId: co, tokenHash: "h2" }).returning();
    const base = { companyId: co, projectId: ctx.project.id, ticketId: ctx.ticketId, commit: "c", tree: "t" };
    const at = (minsAgo: number) => new Date(Date.UTC(2026, 10, 20, 12, 0) - minsAgo * 60_000);
    await ctx.db.insert(checkJobs).values({ ...base, kind: "pre_review", scope: "quick", state: "failed", runnerId: runner!.id, queuedAt: at(30), startedAt: at(29), endedAt: at(25), logTail: "ok one\n FAIL  test/foo.test.ts > adds up\nmore" });
    await ctx.db.insert(checkJobs).values({ ...base, kind: "merge", state: "stuck", workerId: worker!.id, queuedAt: at(20), startedAt: at(19), endedAt: at(10), reason: "no output for 15 minutes" });
    await ctx.db.insert(checkJobs).values({ ...base, kind: "pre_review", scope: "full", state: "passed", workerId: worker!.id, queuedAt: at(9), startedAt: at(8), endedAt: at(2), logTail: "error: noise in a passing log" });
    await ctx.db.insert(checkJobs).values({ ...base, kind: "pre_review", scope: "quick", state: "queued", queuedAt: at(1) });
    // Another ticket's check must not show.
    const [other] = await ctx.db.insert(tickets).values({ companyId: co, projectId: ctx.project.id, title: "Other" }).returning();
    await ctx.db.insert(checkJobs).values({ ...base, ticketId: other!.id, kind: "merge", state: "failed" });

    const { checks } = (await ctx.req("GET", `/api/tickets/${ctx.ticketId}/checks`)).json() as { checks: Array<Record<string, unknown>> };
    expect(checks.map((c) => [c.what, c.state, c.machine])).toEqual([
      ["quick", "queued", null],
      ["full", "passed", "Big box"],
      ["merge", "stuck", "Big box"],
      ["quick", "failed", "company runner"],
    ]);
    expect(checks[0]!.startedAt).toBeNull();
    expect(checks[1]!.firstLine).toBeNull(); // a passed check has no failing line, whatever its log says
    expect(checks[2]!.firstLine).toBe("no output for 15 minutes"); // no log: the recorded reason
    expect(checks[3]!.firstLine).toContain("test/foo.test.ts");
    expect(checks[3]).toMatchObject({ startedAt: at(29).toISOString(), endedAt: at(25).toISOString() });
  });

  it("stops at the newest 50", async () => {
    const base = { companyId: ctx.co.company.id, projectId: ctx.project.id, ticketId: ctx.ticketId, kind: "pre_review", commit: "c", tree: "t", state: "passed" };
    await ctx.db.insert(checkJobs).values(Array.from({ length: 51 }, (_, i) => ({ ...base, queuedAt: new Date(Date.UTC(2026, 10, 20, 12, i)) })));
    const { checks } = (await ctx.req("GET", `/api/tickets/${ctx.ticketId}/checks`)).json() as { checks: Array<{ queuedAt: string }> };
    expect(checks).toHaveLength(50);
    expect(checks[0]!.queuedAt).toBe(new Date(Date.UTC(2026, 10, 20, 12, 50)).toISOString());
    expect(checks.at(-1)!.queuedAt).toBe(new Date(Date.UTC(2026, 10, 20, 12, 1)).toISOString());
  });
});
