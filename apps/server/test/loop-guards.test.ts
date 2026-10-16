import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { budgetPolicies, costEvents, decisions, runners, runs, tickets, wakes } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(loopLimits: Record<string, number> = {}) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, workspaceRoot: "/ws", loopLimits });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id, state: "review" })).json() as { id: string };
  await db.delete(wakes);
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event });
  const state = async () => (await db.select().from(tickets).where(eq(tickets.id, ticket.id)))[0]!;
  return { ...built, db, close, req, company, ceo, worker, project, ticket, sent, emit, state };
}

const flush = () => new Promise((r) => setTimeout(r, 100));

describe("bounded review loops (R49)", () => {
  it("holds the third round of the same comment for the owner, who can send it back or stop work", async () => {
    const c = (ctx = await setup());
    const send = () => c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "changes_requested", comments: [{ path: "src/limit.ts", line: 1, body: "Read the limit from config.", code: "x" }] });
    for (let i = 0; i < 2; i++) {
      expect((await send()).json()).toMatchObject({ delivered: "the assignee will be woken with it" });
      await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "review" });
    }
    await c.db.delete(wakes);
    const third = (await send()).json();
    expect(third.delivered).toMatch(/^held for the owner/);
    expect(await c.db.select().from(wakes)).toHaveLength(0);
    expect((await c.state()).systemState).toBe("blocked");
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(d!.question).toMatch(/the same comment has now come back 3 times: "src\/limit\.ts: Read the limit from config\."/);

    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Send it back anyway" });
    expect((await c.state()).systemState).toBe("in_progress");
    expect((await c.db.select().from(wakes))[0]!.note).toContain("> Read the limit from config.");
  });

  it("caps the number of rounds even when the comments differ, and stopping cancels the ticket", async () => {
    const c = (ctx = await setup({ maxRounds: 2 }));
    for (let i = 0; i < 3; i++) {
      await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "changes_requested", summary: `Round ${i + 1}: something new` });
      if (i < 2) await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "review" });
    }
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "approval"));
    expect(d!.question).toMatch(/sent back 3 times/);
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Stop work on it" });
    expect(await c.state()).toMatchObject({ systemState: "done", outcome: "cancelled" });
  });
});

describe("circular failures (R50)", () => {
  it("tells the owner once when a ticket's runs keep failing the same way", async () => {
    const c = (ctx = await setup());
    const fail = async (error: string) => {
      const runId = randomUUID();
      await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId: c.ticket.id });
      await c.emit({ type: "run.ended", runId, stopReason: null, error });
      await flush();
    };
    await fail("TypeError: cannot read properties of undefined (reading 'limit') at /tmp/ws-a1b2c3d/x.ts:10:3");
    await fail("Model overloaded (529)");
    await fail("TypeError: cannot read properties of undefined (reading 'limit') at /tmp/ws-9z8y7x6/x.ts:12:9");
    expect(await c.db.select().from(decisions).where(eq(decisions.kind, "question"))).toHaveLength(0);
    await fail("TypeError: cannot read properties of undefined (reading 'limit') at /tmp/ws-q1w2e3r/x.ts:14:1");
    await fail("TypeError: cannot read properties of undefined (reading 'limit') at /tmp/ws-zzzzzzz/x.ts:15:1");
    const alerts = await c.db.select().from(decisions).where(eq(decisions.kind, "question"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.question).toMatch(/^An agent run has hit the same failure 3 times in 2 hours on "Add rate limiting"/);
  });
});

describe("spend caps (R53)", () => {
  it("stops a ticket at its cap across all runs, and raising the cap lets it go again", async () => {
    const c = (ctx = await setup());
    await c.req("PATCH", `/api/projects/${c.project.id}`, { ticketCostCapUsd: 1 });
    const fs = (await c.req("POST", "/api/funding-sources", { name: "API", kind: "api_payg", provider: "anthropic" })).json();
    for (const usd of [0.6, 0.5]) {
      const runId = randomUUID();
      await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, ticketId: c.ticket.id, endedAt: new Date() });
      await c.db.insert(costEvents).values({ fundingSourceId: fs.id, companyId: c.company.id, runId, costMicros: usd * 1e6 });
    }
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: c.ticket.id, reason: "assigned" });
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0, deferred: 1 });
    const [d] = await c.db.select().from(decisions).where(eq(decisions.kind, "budget"));
    expect(d!.question).toBe('"Add rate limiting" has used $1.10 of its $1.00 cap across all its runs. Raise the cap by half, or stop work on it?');

    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Raise the cap by half" });
    expect((await c.state()).costCapMicros).toBe(1_500_000);
    expect(await c.scheduler.tick()).toMatchObject({ launched: 1 });
  });

  it("an instance-wide budget pauses every company, and project budgets now count too", async () => {
    const c = (ctx = await setup());
    const fs = (await c.req("POST", "/api/funding-sources", { name: "API", kind: "api_payg", provider: "anthropic" })).json();
    await c.req("POST", "/api/cost-events", { fundingSourceId: fs.id, companyId: c.company.id, costUsd: 5 });
    const instance = (await c.req("POST", "/api/budget-policies", { scopeKind: "instance", windowKind: "lifetime", limitUsd: 3, onLimit: "pause" })).json();
    expect(instance.scopeId).toBe("00000000-0000-0000-0000-000000000000");
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "start" });
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0, deferred: 1 });
    expect((await c.req("POST", "/api/budget-policies", { scopeKind: "company", windowKind: "lifetime", limitUsd: 3, onLimit: "pause" })).statusCode).toBe(400);
  });

  it("a paused project budget stops that project's tickets", async () => {
    const c = (ctx = await setup());
    const fs = (await c.req("POST", "/api/funding-sources", { name: "API", kind: "api_payg", provider: "anthropic" })).json();
    await c.db.insert(costEvents).values({ fundingSourceId: fs.id, companyId: c.company.id, projectId: c.project.id, costMicros: 2_000_000 });
    await c.req("POST", "/api/budget-policies", { scopeKind: "project", scopeId: c.project.id, windowKind: "lifetime", limitUsd: 1, onLimit: "pause" });
    await c.scheduler.wake({ agentId: c.worker.id, ticketId: c.ticket.id, reason: "assigned" });
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0, deferred: 1 });
    expect((await c.db.select().from(wakes).where(and(eq(wakes.ticketId, c.ticket.id), eq(wakes.status, "deferred"))))[0]!.statusReason).toBe("budget limit reached");
  });

  it("a soft budget asks the owner once and lets work carry on; the answer raises it or makes it a hard stop", async () => {
    const c = (ctx = await setup());
    const fs = (await c.req("POST", "/api/funding-sources", { name: "API", kind: "api_payg", provider: "anthropic" })).json();
    await c.db.insert(costEvents).values({ fundingSourceId: fs.id, companyId: c.company.id, costMicros: 2_000_000 });
    const policy = (await c.req("POST", "/api/budget-policies", { scopeKind: "company", scopeId: c.company.id, windowKind: "lifetime", limitUsd: 1.5, onLimit: "ask" })).json();

    await c.scheduler.wake({ agentId: c.worker.id, ticketId: c.ticket.id, reason: "assigned" });
    expect(await c.scheduler.tick()).toMatchObject({ launched: 1 });
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "check in" });
    await c.scheduler.tick();
    const asks = await c.db.select().from(decisions).where(eq(decisions.kind, "budget"));
    expect(asks).toHaveLength(1);
    expect(asks[0]!.question).toBe("App Co has used $2.00 of a $1.50 budget in total. Work carries on, because this limit only asks. Raise it by half, make it a hard stop, or leave it as it is?");

    await c.req("POST", `/api/decisions/${asks[0]!.id}/answer`, { answer: "Raise it by half" });
    expect((await c.db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id)))[0]!.limitMicros).toBe(2_250_000);

    // Past the new limit it asks again, and a hard stop then pauses the company's work.
    await c.db.insert(costEvents).values({ fundingSourceId: fs.id, companyId: c.company.id, costMicros: 1_000_000 });
    await c.db.update(runs).set({ endedAt: new Date() });
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "again" });
    await c.scheduler.tick();
    const [again] = await c.db.select().from(decisions).where(and(eq(decisions.kind, "budget"), eq(decisions.status, "open")));
    await c.req("POST", `/api/decisions/${again!.id}/answer`, { answer: "Make it a hard stop" });
    await c.db.update(runs).set({ endedAt: new Date() });
    await c.scheduler.wake({ agentId: c.ceo.id, reason: "once more" });
    expect(await c.scheduler.tick()).toMatchObject({ launched: 0, deferred: 1 });
  });
});
