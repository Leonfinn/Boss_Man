import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, notifications, ticketDependencies, ticketReviews, tickets, wakes, watchdogActions, watchdogFlags } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { WATCHDOG_REASON } from "../src/services/watchdog.js";

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];


async function setup() {
  // The database stamps state changes with its own clock, so the test clock starts at the real time.
  let clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const companyId = co.company.id;
  const sm = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Scrum Master" })).json() as { id: string };
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Developer" })).json() as { id: string };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const project = (await req("POST", `/api/companies/${companyId}/projects`, { name: "Site" })).json() as { id: string };
  const advance = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));
  const ago = (minutes: number) => new Date(clock.getTime() - minutes * 60_000);
  const ticket = async (patch: Partial<typeof tickets.$inferInsert> = {}) =>
    (await db.insert(tickets).values({ companyId, projectId: project.id, title: "Add rate limiting", systemState: "in_progress", assigneeAgentId: dev.id, stateChangedAt: ago(10), ...patch }).returning())[0]!;
  const switchOn = async (extra: Record<string, unknown> = {}) => {
    const r = await req("PATCH", `/api/companies/${companyId}/watchdog`, { scrumMasterAgentId: sm.id, enabled: true, ...extra });
    expect(r.statusCode).toBe(200);
    return r.json();
  };
  const smWakes = () => db.select().from(wakes).where(and(eq(wakes.agentId, sm.id), eq(wakes.reason, WATCHDOG_REASON)));
  const launched = async () => db.update(wakes).set({ status: "launched" }).where(eq(wakes.agentId, sm.id));
  return { ...built, db, close, base, req, companyId, sm, dev, ceo: ceo!, project, advance, ago, ticket, switchOn, smWakes, launched, now: () => clock };
}


beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

async function client(agentId: string) {
  const token = await issueRunToken(ctx.db, { companyId: ctx.companyId, agentId, runId: randomUUID() });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}
const isError = (r: unknown) => !!(r as { isError?: boolean }).isError;
const call = async (args: Record<string, unknown>) => (await client(ctx.sm.id)).callTool({ name: "watchdog", arguments: args });

// Regression tests for the six findings of the BOS-74 adversarial review. Each asserts the behaviour that should happen.
describe("watchdog hardening", () => {
  it("A4: a busy board does not switch the watchdog off", async () => {
    await ctx.switchOn();
    for (let i = 0; i < 40; i++) await ctx.ticket({ title: `Unassigned ${i}`, assigneeAgentId: null, stateChangedAt: ctx.ago(60) });
    for (let i = 0; i < 8; i++) {
      ctx.advance(5);
      await ctx.launched();
      await ctx.watchdog.run();
    }
    expect((await ctx.watchdog.status(ctx.companyId)).trippedAt).toBeNull();
  });

  it("A5: a queued wake behind a paused agent does not hide a stuck ticket from the watchdog", async () => {
    await ctx.switchOn();
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.dev.id));
    const t = await ctx.ticket({ title: "Stuck with a pending wake", stateChangedAt: ctx.ago(600) });
    await ctx.db.insert(wakes).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, reason: "message", status: "queued" });
    await ctx.watchdog.run();
    expect(await ctx.db.select().from(watchdogFlags)).toHaveLength(1);
  });

  it("A6: one hand-off from the Scrum Master takes one action on a flag", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Stuck", stateChangedAt: ctx.ago(130) });
    await ctx.watchdog.run();
    await ctx.launched();
    const [f] = await ctx.db.select().from(watchdogFlags);
    await call({ action: "snooze", flagId: f!.id, hours: 1, reason: "waiting on CI" });
    await call({ action: "nudge", ticketId: t.id, reason: "any movement?" });
    await call({ action: "escalate", ticketId: t.id, reason: "needs the CEO" });
    const acts = await ctx.db.select().from(watchdogActions).where(and(eq(watchdogActions.companyId, ctx.companyId), sql`${watchdogActions.kind} not in ('sweep_wake', 'daily_summary')`));
    // The daily summary also goes out on any sweep after 08:00 owner time (the test clock is real time), so it is not counted.
    expect(acts).toHaveLength(1);
  });

  it("A8: one sweep sends the owner a capped number of waiting-ticket reminders", async () => {
    await ctx.switchOn();
    for (let i = 0; i < 25; i++) {
      const t = await ctx.ticket({ title: `Waiting ${i}`, systemState: "blocked", stateChangedAt: ctx.ago(600) });
      const [d] = await ctx.db.insert(decisions).values({ companyId: ctx.companyId, kind: "question", question: `Q${i}?`, options: ["Done", "No"], recommendedOption: "Done", createdAt: ctx.ago(500) }).returning();
      await ctx.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: d!.id });
    }
    await ctx.watchdog.run();
    const notes = await ctx.db.select().from(notifications).where(sql`${notifications.title} like '%for your decision'`);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.length).toBeLessThanOrEqual(3);
  });

  it("A9b: escalating one problem leaves the other problems on the ticket open", async () => {
    await ctx.switchOn();
    const t = await ctx.ticket({ title: "Bouncy and stale", stateChangedAt: ctx.ago(300) });
    for (let i = 0; i < 3; i++) await ctx.db.insert(ticketReviews).values({ ticketId: t.id, reviewer: "Senior Developer", verdict: "changes_requested" });
    await ctx.watchdog.run();
    await ctx.launched();
    expect((await ctx.db.select().from(watchdogFlags)).length).toBeGreaterThan(1);
    const r = await call({ action: "escalate", ticketId: t.id, reason: "needs the CEO" });
    expect(isError(r)).toBe(false);
    expect((await ctx.db.select().from(watchdogFlags)).filter((f) => f.escalatedAt === null)).toHaveLength(1);
  });

  it("A1b: the owner can undo an automatic escalation", async () => {
    await ctx.switchOn();
    await ctx.ticket({ title: "Slow", stateChangedAt: ctx.ago(130) });
    await ctx.watchdog.run();
    await ctx.launched();
    const [f] = await ctx.db.select().from(watchdogFlags);
    await ctx.db.update(watchdogFlags).set({ snoozeCount: 2, dueAt: ctx.now() }).where(eq(watchdogFlags.id, f!.id));
    await ctx.watchdog.run();
    const [act] = await ctx.db.select().from(watchdogActions).where(eq(watchdogActions.kind, "auto_escalate"));
    expect(act).toBeDefined();
    const u = await ctx.req("POST", `/api/watchdog-actions/${act!.id}/undo`, { reason: "not needed" });
    expect(u.statusCode).toBe(200);
  });
});

// BOS-63 (QA): end-to-end checks the per-rule tests don't make.
describe("QA: nudge storm and active runs (BOS-63)", () => {
  it("a storm of nudges stops at the default hourly cap, switches the watchdog off and tells the owner once", async () => {
    await ctx.switchOn();
    const ts = [];
    for (let i = 0; i < 30; i++) ts.push(await ctx.ticket({ title: `Stuck ${i}`, stateChangedAt: ctx.ago(130) }));
    await ctx.watchdog.run();
    await ctx.launched();
    const cap = (await ctx.watchdog.status(ctx.companyId)).settings.maxNudgesPerHour;
    expect(cap).toBe(12);
    let refused = 0;
    for (const t of ts) {
      const r = await call({ action: "nudge", ticketId: t.id, reason: "storm test nudge" });
      if (isError(r)) refused++;
    }
    const nudges = await ctx.db.select().from(watchdogActions).where(and(eq(watchdogActions.companyId, ctx.companyId), eq(watchdogActions.kind, "nudge")));
    expect(nudges.length).toBeLessThanOrEqual(cap);
    expect(refused).toBeGreaterThanOrEqual(30 - cap - 1);
    const st = await ctx.watchdog.status(ctx.companyId);
    expect(st.pausedUntil).not.toBeNull();
    expect((await ctx.db.select().from(notifications)).filter((n) => n.title === "The watchdog paused itself for an hour")).toHaveLength(1);
    expect((await ctx.db.select().from(decisions)).filter((d) => d.question.includes("paused itself"))).toHaveLength(1);
    // For the rest of the hour the sweep does nothing and nothing more is sent.
    const before = (await ctx.db.select().from(notifications)).length;
    for (let h = 0; h < 4; h++) {
      ctx.advance(10);
      await ctx.watchdog.run();
    }
    expect(await ctx.smWakes()).toHaveLength(1);
    expect((await ctx.db.select().from(notifications)).length).toBe(before);
  });

  it("a ticket with a run working on it is not flagged in progress, review or blocked, however long", async () => {
    await ctx.switchOn();
    const { runs } = await import("../src/db/schema.js");
    for (const [i, systemState] of (["in_progress", "review", "blocked"] as const).entries()) {
      const t = await ctx.ticket({ title: `Busy ${systemState}`, systemState, stateChangedAt: ctx.ago(2000) });
      await ctx.db.insert(runs).values({ companyId: ctx.companyId, agentId: ctx.dev.id, ticketId: t.id, startedAt: ctx.ago(5 + i) });
    }
    await ctx.watchdog.run();
    expect(await ctx.db.select().from(watchdogFlags)).toHaveLength(0);
  });
});
