import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkJobs, costEvents, fundingSources, projects, runs, tickets } from "../src/db/schema.js";
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
