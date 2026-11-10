import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BUILT_IN_RULES, type RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { appCache, sharedDatabase } from "./helpers/shared-server.js";
import { decisions, fundingSources, notifications, quotaSamples, runners, runTokens, runs, ticketDependencies, tickets, wakes } from "../src/db/schema.js";
import { hashToken } from "../src/auth.js";
import type { Limits } from "../src/services/scheduler.js";

let ctx: Awaited<ReturnType<typeof setup>>;

// One database for the file, emptied before each test, and one app per set of limits (BOS-686). Every test
// makes its own company, owner, runner and agents; nothing a test made is left for the next one.
let shared: Awaited<ReturnType<typeof sharedDatabase>>;
const apps = appCache<Awaited<ReturnType<typeof buildApp>>>();
beforeAll(async () => {
  shared = await sharedDatabase();
});
afterEach(() => ctx?.release());
afterAll(async () => {
  await apps.closeAll();
  await shared.close();
});

async function setup(limits: Partial<Limits> = {}) {
  await shared.reset();
  const { db } = shared;
  const built = await apps.get(JSON.stringify(limits), () => buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0, ...limits }, workspaceRoot: "/ws" }));
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  // A fake connected runner that records commands.
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  // Every command of any kind, for tests that check nothing was cancelled.
  const sent: RunnerCommand[] = [];
  let online = true;
  const release = built.runners.connect(reg.runnerId, (c) => {
    if (!online) return false;
    sent.push(c);
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  let seq = 0;
  const endRun = (runId: string) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event: { type: "run.ended", runId, stopReason: "end_turn", error: null } });
  const setOnline = (v: boolean) => (online = v);
  // Both production passes (BOS-414): the queue pass and the slower watch/monitor/quota pass.
  const tick = async () => {
    await built.scheduler.slow();
    return built.scheduler.tick();
  };
  return { ...built, db, release, cookie, req, company, ceo, project, commands, sent, endRun, setOnline, tick };
}

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("scheduler", () => {
  it("launches an assigned ticket with a prompt and a working MCP token, one run per agent at a time", async () => {
    ctx = await setup();
    const t1 = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Checkout error states", assigneeAgentId: ctx.ceo.id })).json();
    await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Load test", assigneeAgentId: ctx.ceo.id });

    const first = await ctx.tick();
    expect(first).toMatchObject({ launched: 1, waiting: 1 });
    const cmd = ctx.commands[0]!;
    expect(cmd).toMatchObject({ agentId: ctx.ceo.id, agentKind: "claude", cwd: `/ws/${t1.id}` });
    expect(cmd.prompt).toContain("Checkout error states");
    expect(cmd.prompt).toContain("set_ticket_state");
    expect(cmd.prompt).toContain("call schedule_check rather than ending without a plan");
    expect(cmd.prompt).toMatch(/version 2\)[^\n]*Checkout error states/); // started by the launch, so the version it quotes is current (R81)
    expect(cmd.prompt).toContain("expected_version");
    expect(cmd.prompt).toContain("Every ticket_reply starts with 1 to 3 plain sentences");
    expect(cmd.prompt).toContain("Details:");
    // The built-in safety rules, though the company set no standing rules, and outside the untrusted brief (BOS-754).
    const rules = BUILT_IN_RULES.join("\n");
    expect(cmd.prompt).toContain(rules);
    expect(cmd.prompt.indexOf(rules)).toBeLessThan(cmd.prompt.indexOf("<untrusted"));
    const [tok] = await ctx.db.select().from(runTokens).where(eq(runTokens.tokenHash, hashToken(cmd.mcpToken)));
    expect(tok).toMatchObject({ runId: cmd.runId, agentId: ctx.ceo.id });
    // The ticket being worked on leaves the backlog; the one still waiting stays put.
    const board = (await ctx.req("GET", `/api/projects/${ctx.project.id}/board`)).json() as { columns: Array<{ systemState: string; tickets: Array<{ title: string }> }> };
    const lane = (state: string) => board.columns.find((c) => c.systemState === state)!.tickets.map((t) => t.title);
    expect(lane("in_progress")).toEqual(["Checkout error states"]);
    expect(lane("backlog")).toEqual(["Load test"]);
    // The runs list says why each run started.
    expect((await ctx.req("GET", "/api/runs")).json()).toEqual([expect.objectContaining({ id: cmd.runId, ticket: "Checkout error states", reason: "assigned", purpose: null })]);

    // The second ticket waits until the first run ends; the run's end triggers a pass.
    await ctx.endRun(cmd.runId);
    await flush();
    expect(ctx.commands).toHaveLength(2);
    expect(ctx.commands[1]!.prompt).toContain("Load test");
  });

  it("records a run's tokens and says how it's paid for, so subscriptions show tokens (R67)", async () => {
    ctx = await setup();
    const source = (await ctx.req("POST", "/api/funding-sources", { name: "Claude Max", kind: "subscription", provider: "anthropic" })).json() as { id: string };
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: source.id });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "woken by owner" });
    await ctx.scheduler.tick();
    const runId = ctx.commands[0]!.runId;
    const [runnerRow] = await ctx.db.select().from(runners);
    await ctx.runners.ingest(runnerRow!, {
      seq: 1,
      at: new Date().toISOString(),
      event: { type: "run.ended", runId, stopReason: "end_turn", error: null, usage: { inputTokens: 1_234_567, outputTokens: 45_600, cachedReadTokens: 900_000, cachedWriteTokens: 12_000 } },
    });
    const [row] = (await ctx.req("GET", "/api/runs/recent")).json() as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ id: runId, inputTokens: 1_234_567, outputTokens: 45_600, cachedReadTokens: 900_000, cachedWriteTokens: 12_000, fundingKind: "subscription" });
  });

  it("respects the global and company kill switches", async () => {
    ctx = await setup();
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, {});
    // The owner's Settings switch and banner read the real hold (BOS-836): off before anyone set it, owner-only.
    expect((await ctx.req("GET", "/api/kill-switch")).json()).toEqual({ paused: false });
    expect((await ctx.app.inject({ method: "GET", url: "/api/kill-switch" })).statusCode).toBe(401);
    await ctx.req("POST", "/api/kill-switch", { paused: true });
    expect((await ctx.req("GET", "/api/kill-switch")).json()).toEqual({ paused: true });
    expect(await ctx.tick()).toMatchObject({ paused: true, launched: 0 });
    await ctx.req("POST", "/api/kill-switch", { paused: false });
    expect((await ctx.req("GET", "/api/kill-switch")).json()).toEqual({ paused: false });
    await ctx.req("POST", `/api/companies/${ctx.company.id}/pause`, { paused: true });
    expect(await ctx.tick()).toMatchObject({ launched: 0, waiting: 1 });
    await ctx.req("POST", `/api/companies/${ctx.company.id}/pause`, { paused: false });
    expect(await ctx.tick()).toMatchObject({ launched: 1 });
  });

  it("Stop all work (BOS-836): a fresh server starts work as today; the hold keeps a wake waiting without cancelling a run already going; Resume launches it", async () => {
    ctx = await setup();
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json() as { id: string };
    // A fresh database: no hold row at all, so no banner, and a wake launches.
    expect((await ctx.req("GET", "/api/kill-switch")).json()).toEqual({ paused: false });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, {});
    expect(await ctx.tick()).toMatchObject({ paused: false, launched: 1 });
    const going = ctx.commands[0]!.runId;
    // The press: the same POST the Settings button sends.
    await ctx.req("POST", "/api/kill-switch", { paused: true });
    await ctx.req("POST", `/api/agents/${worker.id}/wake`, {});
    expect(await ctx.tick()).toMatchObject({ paused: true, launched: 0 });
    expect(await ctx.tick()).toMatchObject({ paused: true, launched: 0 });
    expect(ctx.commands).toHaveLength(1);
    const [waiting] = await ctx.db.select().from(wakes).where(eq(wakes.agentId, worker.id));
    expect(waiting!.status).toBe("queued");
    // The run already going is left alone: still open, and no cancel was sent.
    const [run] = await ctx.db.select().from(runs).where(eq(runs.id, going));
    expect(run!.endedAt).toBeNull();
    expect(ctx.sent.filter((c) => c.type === "run.cancel")).toEqual([]);
    // Resume: the banner's POST. The waiting wake launches on the next tick.
    await ctx.req("POST", "/api/kill-switch", { paused: false });
    expect(await ctx.tick()).toMatchObject({ paused: false, launched: 1 });
    expect(ctx.commands.map((c) => c.agentId)).toEqual([ctx.ceo.id, worker.id]);
  });

  it("waits while the runner is offline", async () => {
    ctx = await setup();
    ctx.setOnline(false);
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, {});
    await ctx.tick();
    const [w] = await ctx.db.select().from(wakes);
    expect(w).toMatchObject({ status: "queued", statusReason: "runner offline" });
    ctx.setOnline(true);
    expect(await ctx.tick()).toMatchObject({ launched: 1 });
  });

  it("drops wake chains deeper than the limit and tells the owner", async () => {
    ctx = await setup({ maxDepth: 1, agent: 5 });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "start" });
    await ctx.scheduler.tick();
    const runA = ctx.commands[0]!.runId;
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "follow-up", causedByRunId: runA });
    await ctx.scheduler.tick();
    const runB = ctx.commands[1]!.runId;
    const dropped = await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "again", causedByRunId: runB });
    expect(dropped).toMatchObject({ status: "dropped", causationDepth: 2 });
    const alerts = await ctx.db.select().from(decisions);
    expect(alerts[0]!.question).toMatch(/looks like a loop/);
  });

  it("limits how often an agent can wake itself", async () => {
    ctx = await setup({ selfWakesPer10Min: 2, maxDepth: 100, agent: 10 });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "start" });
    await ctx.scheduler.tick();
    const run = ctx.commands[0]!.runId;
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "self", causedByRunId: run }));
    expect(results.map((r) => r.status)).toEqual(["queued", "queued", "dropped"]);
  });

  it("a resume after a restart is not the agent waking itself, and the self-wake limit still catches a real loop (BOS-479)", async () => {
    ctx = await setup({ selfWakesPer10Min: 5, maxDepth: 100, agent: 10 });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "start" });
    await ctx.scheduler.tick();
    const run = ctx.commands[0]!.runId;
    for (let i = 0; i < 4; i++) expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "self", causedByRunId: run })).toMatchObject({ status: "queued" });
    // Two resumes from the restart: neither is dropped, and no "keeps waking itself" card is raised.
    for (let i = 0; i < 2; i++) expect(await ctx.recovery.onInterrupted(run)).toMatchObject({ status: expect.not.stringMatching(/dropped/) });
    expect((await ctx.db.select().from(decisions)).filter((d) => /keeps waking itself/.test(d.question))).toHaveLength(0);
    // Six real self-wakes in total are still stopped, with the alert.
    expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "self", causedByRunId: run })).toMatchObject({ status: "queued" });
    expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "self", causedByRunId: run })).toMatchObject({ status: "dropped" });
    expect((await ctx.db.select().from(decisions)).filter((d) => /keeps waking itself/.test(d.question))).toHaveLength(1);
  });

  it("a resume wake keeps the wake depth of the run it picks up (BOS-479)", async () => {
    ctx = await setup({ maxDepth: 100, agent: 10 });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "start" });
    await ctx.scheduler.tick();
    const runA = ctx.commands[0]!.runId;
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "follow-up", causedByRunId: runA });
    await ctx.endRun(runA);
    await ctx.scheduler.tick();
    const runB = ctx.commands[1]!.runId;
    const [parent] = await ctx.db.select().from(wakes).where(eq(wakes.runId, runB));
    expect(parent!.causationDepth).toBe(1);
    expect(await ctx.recovery.onInterrupted(runB)).toMatchObject({ causationDepth: 1 });
  });

  it("caps an agent's runs with no ticket, but never the owner's own (R68)", async () => {
    ctx = await setup();
    for (let i = 0; i < 6; i++) await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "triage", note: `d${i}` });
    const seventh = await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "triage", note: "d6" });
    expect(seventh).toMatchObject({ status: "dropped", statusReason: "more than 6 wakes with no ticket in an hour" });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "triage", note: "d7" });
    // The owner hears once, not for every dropped wake.
    const alerts = (await ctx.db.select().from(decisions)).filter((d) => /with no ticket/.test(d.question));
    expect(alerts).toHaveLength(1);
    // The owner's own wake and ticket work still go through.
    expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "woken by owner" })).toMatchObject({ status: "queued" });
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Real work" })).json();
    expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "assigned", ticketId: t.id })).toMatchObject({ status: "queued" });
  });

  it("never counts or drops the watchdog's sweep wake against the no-ticket limit", async () => {
    ctx = await setup();
    for (let i = 0; i < 6; i++) await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "triage", note: `d${i}` });
    expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "watchdog", note: "sweep" })).toMatchObject({ status: "queued" });
    // The sweeps don't use up the agent's other no-ticket wakes either.
    const other = await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "triage", note: "d6" });
    expect(other).toMatchObject({ status: "dropped" });
  });

  it("never caps the CEO's 'decision' wakes (cards) at the no-ticket limit (BOS-272)", async () => {
    ctx = await setup();
    for (let i = 0; i < 6; i++) await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "triage", note: `t${i}` });
    // Past the ticketless cap, a card for the CEO (a permission request or an alert) still queues;
    // on the old code it was dropped, so the card skipped the CEO and landed on the owner.
    const card = await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "decision", priority: 3, note: "A decision is waiting for you." });
    expect(card).toMatchObject({ status: "queued" });
    // Card wakes don't use up the agent's other no-ticket wakes either way.
    expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "triage", note: "t6" })).toMatchObject({ status: "dropped" });
    expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "decision", priority: 3, note: "Another card." })).toMatchObject({ status: "queued" });
  });

  it("defers when a pausing budget is exceeded, failing closed", async () => {
    ctx = await setup();
    const fs = (await ctx.req("POST", "/api/funding-sources", { name: "API", kind: "api_payg", provider: "anthropic" })).json();
    await ctx.req("POST", "/api/budget-policies", { scopeKind: "company", scopeId: ctx.company.id, windowKind: "lifetime", limitUsd: 1, onLimit: "pause" });
    await ctx.req("POST", "/api/cost-events", { fundingSourceId: fs.id, companyId: ctx.company.id, costUsd: 2 });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, {});
    expect(await ctx.tick()).toMatchObject({ launched: 0, deferred: 1 });
    expect((await ctx.db.select().from(wakes))[0]).toMatchObject({ status: "deferred", statusReason: "budget limit reached" });
  });

  it("holds low-priority work while the subscription window is full, until it resets", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    const resets = Math.floor(Date.now() / 1000) + 3600;
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day", unifiedWindows: { seven_day: { utilization: 1, resetsAt: resets } } } } });

    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 3 });
    expect(await ctx.tick()).toMatchObject({ launched: 1, deferred: 1 });
    const low = (await ctx.db.select().from(wakes)).find((w) => w.priority === 2)!;
    expect(low.status).toBe("deferred");
    expect(low.notBefore?.getTime()).toBe(resets * 1000);
  });

  it("runs an urgent ticket at 96% while routine work is held", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { status: "rejected", rateLimitType: "seven_day", unifiedWindows: { seven_day: { utilization: 0.96, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: ctx.ceo.id })).json();
    const routine = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Routine work", assigneeAgentId: ctx.ceo.id })).json();
    await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
    expect(await ctx.tick()).toMatchObject({ launched: 1, deferred: 1 });
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, urgent.id)))[0]!.systemState).toBe("in_progress");
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, routine.id)))[0]!.systemState).toBe("backlog");
  });

  it("holds even an urgent ticket under the default pause once the window is at its limit", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { overageInUse: true, unifiedWindows: { seven_day: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: ctx.ceo.id })).json();
    await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
    expect(await ctx.tick()).toMatchObject({ launched: 0, deferred: 1 });
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, urgent.id)))[0]!.systemState).toBe("backlog");
  });

  it("lets routine work through windows the owner switched off, and past a raised threshold", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 0.85, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    // 85% is under the default 95%, so it runs.
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
    expect(await ctx.tick()).toMatchObject({ launched: 1 });
    // Raise nothing: switch the only window off and add a fresh full reading.
    await ctx.req("PATCH", `/api/funding-sources/${sub.id}`, { quotaDisabledWindows: ["seven_day"] });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
    expect(await ctx.tick()).toMatchObject({ launched: 1 });
  });

  it("with extra usage set to urgent only, runs urgent work at 100% but holds routine work", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic", quotaOverage: "urgent" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { overageInUse: true, unifiedWindows: { seven_day: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: ctx.ceo.id })).json();
    const routine = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Routine work", assigneeAgentId: ctx.ceo.id })).json();
    await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
    expect(await ctx.tick()).toMatchObject({ launched: 1, deferred: 1 });
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, urgent.id)))[0]!.systemState).toBe("in_progress");
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, routine.id)))[0]!.systemState).toBe("backlog");
  });

  it("keeps all work running when the owner allows extra usage for it", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic", quotaOverage: "all" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { overageInUse: true, unifiedWindows: { seven_day: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
    expect(await ctx.tick()).toMatchObject({ launched: 1 });
  });

  it("releases a quota-held wake when a high-priority note joins it", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2, note: "routine" });
    await ctx.tick();
    const held = (await ctx.db.select().from(wakes))[0]!;
    expect(held.status).toBe("deferred");
    await ctx.scheduler.notify(ctx.ceo.id, { reason: held.reason, note: "Important", priority: 3 });
    const [released] = await ctx.db.select().from(wakes).where(eq(wakes.id, held.id));
    expect(released).toMatchObject({ status: "queued", statusReason: null });
  });

  it("tells the owner once when the hold starts and once when it lifts", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    const meta = (w: number) => ({ "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: w, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: meta(0.99) });
    await ctx.tick();
    expect((await ctx.db.select().from(notifications)).filter((n) => /Routine work paused/.test(n.title))).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: meta(0.2) });
    await ctx.tick();
    expect((await ctx.db.select().from(notifications)).filter((n) => /running again/.test(n.title))).toHaveLength(1);
  });

  it("says once that extra-usage credits are being used", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { overageInUse: true, unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    await ctx.tick();
    await ctx.tick();
    expect((await ctx.db.select().from(notifications)).filter((n) => /credits are now being used/.test(n.title))).toHaveLength(1);
  });

  it("runs a held ticket now when the owner asks", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Held work", assigneeAgentId: ctx.ceo.id })).json();
    await ctx.tick();
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("backlog");
    expect((await ctx.req("POST", `/api/tickets/${t.id}/run-now`)).json()).toEqual({ released: 1 });
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
  });

  it("drops a wake that outlived its ticket, so a long hold can't replay an old nudge (BOS-256)", async () => {
    ctx = await setup({ agent: 5 });
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Finished long ago", assigneeAgentId: worker.id })).json();
    // It closed an hour ago; both wakes were queued before then, as a hold would leave them.
    const closedAt = new Date(Date.now() - 3_600_000);
    await ctx.req("PATCH", `/api/tickets/${t.id}`, { state: "done" });
    await ctx.db.update(tickets).set({ stateChangedAt: closedAt }).where(eq(tickets.id, t.id));
    // What a hold leaves behind: the ticket's own wake, a colleague's nudge on it, and a later one for another ticket.
    await ctx.db.delete(wakes);
    // Backdated, as a wake held overnight would be: the ticket was done after it was queued.
    const wokeAt = new Date(closedAt.getTime() - 20 * 3_600_000);
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: worker.id, ticketId: t.id, reason: "woken by owner", priority: 3, note: "The owner moved this ticket to Ready.", createdAt: wokeAt });
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: worker.id, ticketId: t.id, reason: "nudge", priority: 2, note: "A day-old nudge.", createdAt: wokeAt });
    const later = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Still wanted", assigneeAgentId: worker.id })).json();
    await ctx.db.delete(wakes).where(eq(wakes.ticketId, later.id));
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: worker.id, ticketId: later.id, reason: "woken by owner", priority: 3, note: "Carry on with this." });

    expect(await ctx.tick()).toMatchObject({ launched: 1, dropped: 2 });
    const rows = await ctx.db.select().from(wakes).where(eq(wakes.ticketId, t.id));
    expect(rows.every((w) => w.status === "dropped")).toBe(true);
    expect([...new Set(rows.map((w) => w.statusReason))]).toEqual(["the ticket was already finished, so there was nothing to do"]);
    // Only the live ticket's run started: the finished one's agent wasn't woken for a replay.
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.commands[0]!.prompt).toContain("Still wanted");
  });

  it("drops a replay for a closed ticket, but still starts a nudge sent after it closed (BOS-256)", async () => {
    ctx = await setup({ agent: 5 });
    // A ticket the owner reopened after it closed, then closed once more: it is done, and the reopen
    // moved its state clock past its later activity, so a wake held through the hold is a replay again.
    const reopened = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Reopened then closed", assigneeAgentId: ctx.ceo.id })).json();
    await ctx.req("PATCH", `/api/tickets/${reopened.id}`, { state: "done" });
    // A ticket that is done but was nudged after it closed: that nudge is something new, so its wake
    // has real work to do and must start even though the ticket is closed.
    const nudgedAfter = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "A nudge came in", assigneeAgentId: ctx.ceo.id })).json();
    await ctx.req("PATCH", `/api/tickets/${nudgedAfter.id}`, { state: "done" });
    await ctx.db.delete(wakes);
    const closedAt = new Date(Date.now() - 3_600_000);
    // Both closed an hour ago, and the state clock says so.
    await ctx.db.update(tickets).set({ stateChangedAt: closedAt }).where(eq(tickets.id, reopened.id));
    await ctx.db.update(tickets).set({ stateChangedAt: closedAt }).where(eq(tickets.id, nudgedAfter.id));
    // The first wake was queued before the close (a replay); the second was queued a minute after it.
    const beforeClose = new Date(closedAt.getTime() - 60_000);
    const afterClose = new Date(closedAt.getTime() + 60_000);
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: ctx.ceo.id, ticketId: reopened.id, reason: "woken by owner", priority: 3, note: "Old replay.", createdAt: beforeClose });
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: ctx.ceo.id, ticketId: nudgedAfter.id, reason: "nudge", priority: 2, note: "A nudge sent after it closed.", createdAt: afterClose });

    expect(await ctx.tick()).toMatchObject({ launched: 1, dropped: 1 });
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.commands[0]!.prompt).toContain("A nudge came in");
    const [reopenedRow] = await ctx.db.select().from(wakes).where(eq(wakes.ticketId, reopened.id));
    expect(reopenedRow!.status).toBe("dropped");
    const [nudgedRow] = await ctx.db.select().from(wakes).where(eq(wakes.ticketId, nudgedAfter.id));
    expect(nudgedRow!.status).not.toBe("dropped");
  });

  it("still starts a watch wake for a ticket just closed, so the watcher gives its final update (BOS-256)", async () => {
    ctx = await setup({ agent: 5 });
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Watch then done", assigneeAgentId: ctx.ceo.id })).json();
    await ctx.req("PATCH", `/api/tickets/${t.id}`, { state: "done" });
    await ctx.db.delete(wakes);
    const closedAt = new Date(Date.now() - 3_600_000);
    await ctx.db.update(tickets).set({ stateChangedAt: closedAt }).where(eq(tickets.id, t.id));
    // Not a replay: a watch wake on a closed ticket is how the watcher reports the finish, so it goes ahead.
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: ctx.ceo.id, ticketId: t.id, reason: "ticket watch", priority: 1, note: "Watch it once more.", createdAt: new Date(closedAt.getTime() - 60_000) });
    expect(await ctx.tick()).toMatchObject({ launched: 1, dropped: 0 });
  });

  it("marks a ticket urgent only through the owner path and the managers' tool", async () => {
    ctx = await setup();
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent later" })).json();
    await ctx.req("PATCH", `/api/tickets/${t.id}`, { urgent: true });
    const [row] = await ctx.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row!.urgent).toBe(true);
  });

  it("tells an agent on a ticket to save its state note before ending, but not one with no ticket", async () => {
    ctx = await setup({ instance: 2 });
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.req("POST", `/api/agents/${worker.id}/wake`, { priority: 1, note: "say hi" });
    await ctx.tick();
    const rule = "Before you end your run, record the ticket's current state in its note: call set_ticket_state";
    expect(ctx.commands.find((c) => c.agentId === ctx.ceo.id)!.prompt).toContain(rule);
    expect(ctx.commands.find((c) => c.agentId === worker.id)!.prompt).not.toContain(rule);
  });

  it("launches higher priority first when capacity is short", async () => {
    ctx = await setup({ instance: 1 });
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 1, note: "low" });
    await ctx.req("POST", `/api/agents/${worker.id}/wake`, { priority: 4, note: "urgent" });
    await ctx.tick();
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.commands[0]!.prompt).toContain("urgent");
  });

  it("wakes the agent that asked once the owner answers", async () => {
    ctx = await setup();
    const d = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Which DNS provider?", options: ["deSEC", "Cloudflare"], recommended: "deSEC" });
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "deSEC" });
    // It waits a moment for more answers (R68); move past that.
    await ctx.db.update(wakes).set({ notBefore: new Date(Date.now() - 1000) }).where(eq(wakes.reason, "decision answered"));
    await ctx.tick();
    expect(ctx.commands[0]!.prompt).toContain('The owner answered your question "Which DNS provider?": deSEC');
  });

  it("gives an agent several answers in a row in one run, not one run each (R68)", async () => {
    ctx = await setup();
    const ask = (question: string) => ctx!.decisions.raise({ companyId: ctx!.company.id, agentId: ctx!.ceo.id, question, options: ["Yes", "No"], recommended: "Yes" });
    const [a, b, c] = [await ask("Mission?"), await ask("Objectives?"), await ask("Research first?")];
    await ctx.req("POST", `/api/decisions/${a.id}/answer`, { answer: "Yes" });
    await ctx.tick();
    expect(ctx.commands).toEqual([]);
    const [first] = await ctx.db.select().from(wakes).where(eq(wakes.reason, "decision answered"));
    expect(first).toMatchObject({ status: "deferred", statusReason: "waiting briefly for more \"decision answered\"" });
    expect(first!.notBefore!.getTime() - Date.now()).toBeGreaterThan(100_000);

    // Each answer waits again, but never more than five minutes after the first.
    await ctx.db.update(wakes).set({ createdAt: new Date(Date.now() - 4 * 60_000), notBefore: new Date(Date.now() - 2 * 60_000) }).where(eq(wakes.id, first!.id));
    await ctx.req("POST", `/api/decisions/${b.id}/answer`, { answer: "No" });
    await ctx.req("POST", `/api/decisions/${c.id}/answer`, { answer: "Yes" });
    const all = await ctx.db.select().from(wakes).where(eq(wakes.reason, "decision answered"));
    expect(all).toHaveLength(1);
    expect(Math.abs(all[0]!.notBefore!.getTime() - (Date.now() + 60_000))).toBeLessThan(5_000);

    await ctx.db.update(wakes).set({ notBefore: new Date(Date.now() - 1000) }).where(eq(wakes.id, first!.id));
    await ctx.tick();
    expect(ctx.commands).toHaveLength(1);
    for (const q of ['"Mission?": Yes', '"Objectives?": No', '"Research first?": Yes']) expect(ctx.commands[0]!.prompt).toContain(q);
  });

  it("finishing a ticket unblocks and wakes the work waiting on it", async () => {
    ctx = await setup();
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    const domain = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Domain" })).json();
    const tls = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "TLS", state: "blocked" })).json();
    await ctx.req("POST", `/api/tickets/${tls.id}/dependencies`, { ticketId: domain.id });
    await ctx.req("PATCH", `/api/tickets/${tls.id}`, { assigneeAgentId: worker.id });
    // Assignment while blocked queues a wake too; clear it to isolate the unblock.
    await ctx.db.delete(wakes);
    await ctx.req("PATCH", `/api/tickets/${domain.id}`, { state: "done" });
    const queued = await ctx.db.select().from(wakes);
    // The (paused) wiki maintainer is nudged too; see the wiki maintainer test.
    expect(queued.filter((w) => w.reason !== "wiki upkeep")).toEqual([expect.objectContaining({ agentId: worker.id, ticketId: tls.id, reason: "unblocked" })]);
    const board = (await ctx.req("GET", `/api/projects/${ctx.project.id}/board`)).json();
    const tlsCard = board.columns.flatMap((c: { tickets: Array<{ id: string; systemState: string }> }) => c.tickets).find((c: { id: string }) => c.id === tls.id);
    expect(tlsCard.systemState).toBe("ready");
  });

  describe("backlog tickets waiting on others (BOS-603)", () => {
    const mk = async (title: string, extra: Record<string, unknown> = {}) => (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title, ...extra })).json();
    const stateOf = async (id: string) => (await ctx.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.systemState;
    const unblockedWakes = async (ticketId: string) => (await ctx.db.select().from(wakes)).filter((w) => w.ticketId === ticketId && w.reason === "unblocked");

    it("wakes a backlog ticket when its blocker is done", async () => {
      ctx = await setup();
      const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
      const x = await mk("X");
      const waiting = await mk("Waiting", { assigneeAgentId: worker.id });
      await ctx.req("POST", `/api/tickets/${waiting.id}/dependencies`, { ticketId: x.id });
      expect(await stateOf(waiting.id)).toBe("backlog");
      await ctx.req("PATCH", `/api/tickets/${x.id}`, { state: "done" });
      expect(await stateOf(waiting.id)).toBe("ready");
      expect(await unblockedWakes(waiting.id)).toHaveLength(1);
    });

    it("waits for both blockers", async () => {
      ctx = await setup();
      const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
      const a = await mk("A");
      const b = await mk("B");
      const waiting = await mk("Waiting", { assigneeAgentId: worker.id });
      for (const x of [a, b]) await ctx.req("POST", `/api/tickets/${waiting.id}/dependencies`, { ticketId: x.id });
      await ctx.req("PATCH", `/api/tickets/${a.id}`, { state: "done" });
      expect(await stateOf(waiting.id)).toBe("backlog");
      expect(await unblockedWakes(waiting.id)).toHaveLength(0);
      await ctx.req("PATCH", `/api/tickets/${b.id}`, { state: "done" });
      expect(await stateOf(waiting.id)).toBe("ready");
      expect(await unblockedWakes(waiting.id)).toHaveLength(1);
    });

    it("raises one notice, not a wake, when nobody is assigned", async () => {
      ctx = await setup();
      const x = await mk("X");
      const waiting = await mk("Orphan");
      await ctx.req("POST", `/api/tickets/${waiting.id}/dependencies`, { ticketId: x.id });
      await ctx.req("PATCH", `/api/tickets/${x.id}`, { state: "done" });
      const notices = () => ctx.db.select().from(decisions).then((rows) => rows.filter((d) => d.dedupeKey === `unblocked-unassigned:${waiting.id}`));
      expect(await notices()).toHaveLength(1);
      // The CEO can assign it, so it is the CEO's first (BOS-1015).
      expect((await notices())[0]!.tier).toBe("ceo");
      expect(await unblockedWakes(waiting.id)).toHaveLength(0);
      await ctx.req("POST", "/api/sweep");
      expect(await notices()).toHaveLength(1);
    });

    it("the sweep releases an already-stuck ticket exactly once", async () => {
      ctx = await setup();
      const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
      const x = await mk("X");
      const stuck = await mk("Stuck", { assigneeAgentId: worker.id });
      await ctx.req("POST", `/api/tickets/${stuck.id}/dependencies`, { ticketId: x.id });
      // The blocker finished while the old code ignored backlog tickets: set it done directly.
      await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, x.id));
      await ctx.db.delete(wakes);
      expect(((await ctx.req("POST", "/api/sweep")).json() as { releasedUnblocked: { released: number } }).releasedUnblocked.released).toBe(1);
      expect(await stateOf(stuck.id)).toBe("ready");
      expect(await unblockedWakes(stuck.id)).toHaveLength(1);
      expect(((await ctx.req("POST", "/api/sweep")).json() as { releasedUnblocked: { released: number } }).releasedUnblocked.released).toBe(0);
      expect(await unblockedWakes(stuck.id)).toHaveLength(1);
      const summaries = (await ctx.db.select().from(decisions)).filter((d) => d.dedupeKey === `unblocked-catchup:${ctx.company.id}`);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.question).toContain("Stuck");
      expect(summaries[0]!.tier).toBe("ceo"); // BOS-1015: the summary is for the CEO, not the owner
    });

    it("does not release again a ticket moved back to backlog on purpose", async () => {
      ctx = await setup();
      const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
      const x = await mk("X");
      const held = await mk("Held", { assigneeAgentId: worker.id });
      await ctx.req("POST", `/api/tickets/${held.id}/dependencies`, { ticketId: x.id });
      await ctx.req("PATCH", `/api/tickets/${x.id}`, { state: "done" });
      expect(await stateOf(held.id)).toBe("ready");
      await ctx.req("PATCH", `/api/tickets/${held.id}`, { state: "backlog" });
      await ctx.req("POST", "/api/sweep");
      await ctx.req("POST", "/api/sweep");
      expect(await stateOf(held.id)).toBe("backlog");
      expect(await unblockedWakes(held.id)).toHaveLength(1);
    });

    it("leaves a plain backlog ticket and one waiting on an open decision alone", async () => {
      ctx = await setup();
      const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
      const plain = await mk("Plain", { assigneeAgentId: worker.id });
      const held = await mk("Held", { assigneeAgentId: worker.id });
      const [card] = await ctx.db
        .insert(decisions)
        .values({ companyId: ctx.company.id, kind: "question", question: "Which way?", options: ["A", "B"], recommendedOption: "A", context: { type: "question" } })
        .returning();
      await ctx.db.insert(ticketDependencies).values({ blockedTicketId: held.id, blockerDecisionId: card!.id });
      await ctx.req("POST", "/api/sweep");
      expect(await stateOf(plain.id)).toBe("backlog");
      expect(await stateOf(held.id)).toBe("backlog");
      expect(await unblockedWakes(held.id)).toHaveLength(0);
    });

    it("a backlog ticket parked with a 'blocked until' time ahead is not started; its assignee is told once (BOS-742)", async () => {
      ctx = await setup();
      const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
      const x = await mk("X");
      const waiting = await mk("Waiting", { assigneeAgentId: worker.id });
      await ctx.req("POST", `/api/tickets/${waiting.id}/dependencies`, { ticketId: x.id });
      // Parked on purpose, then left blocked until a date still ahead: a blocked ticket waiting on a blocker is right there.
      await ctx.db.update(tickets).set({ systemState: "blocked", blockedUntil: new Date(Date.now() + 86_400_000), blockedUntilReason: "after the release" }).where(eq(tickets.id, waiting.id));
      await ctx.db.delete(wakes);
      await ctx.req("PATCH", `/api/tickets/${x.id}`, { state: "done" });
      expect(await stateOf(waiting.id)).toBe("blocked");
      const told = await unblockedWakes(waiting.id);
      expect(told).toHaveLength(1);
      expect(told[0]!.note).toContain("parked on purpose");
      // Sweeps leave it alone and don't tell the assignee a second time for the same blocker.
      await ctx.req("POST", "/api/sweep");
      await ctx.req("POST", "/api/sweep");
      expect(await stateOf(waiting.id)).toBe("blocked");
      expect(await unblockedWakes(waiting.id)).toHaveLength(1);
    });

    it("a backlog ticket whose note says parked is not started; its assignee is told the blocker finished (BOS-742)", async () => {
      ctx = await setup();
      const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
      const x = await mk("X");
      const held = await mk("Held", { assigneeAgentId: worker.id });
      await ctx.req("POST", `/api/tickets/${held.id}/dependencies`, { ticketId: x.id });
      await ctx.db.update(tickets).set({ stateNote: "Parked until the pricing change lands; do not start." }).where(eq(tickets.id, held.id));
      await ctx.db.delete(wakes);
      await ctx.req("PATCH", `/api/tickets/${x.id}`, { state: "done" });
      expect(await stateOf(held.id)).toBe("backlog");
      expect(await unblockedWakes(held.id)).toHaveLength(1);
      await ctx.req("POST", "/api/sweep");
      await ctx.req("POST", "/api/sweep");
      expect(await stateOf(held.id)).toBe("backlog");
      expect(await unblockedWakes(held.id)).toHaveLength(1);
    });

    it("the catch-up sweep counts a parked ticket it told the assignee about, and does not start it (BOS-742)", async () => {
      ctx = await setup();
      const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
      const x = await mk("X");
      const held = await mk("Held", { assigneeAgentId: worker.id });
      await ctx.req("POST", `/api/tickets/${held.id}/dependencies`, { ticketId: x.id });
      await ctx.db.update(tickets).set({ blockedUntil: new Date(Date.now() + 86_400_000), stateNote: "Parked: wait for the release." }).where(eq(tickets.id, held.id));
      // The blocker finished while the sweep was not looking: set it done directly.
      await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, x.id));
      await ctx.db.delete(wakes);
      const pass = (await ctx.req("POST", "/api/sweep")).json() as { releasedUnblocked: { released: number; parked: number } };
      expect(pass.releasedUnblocked).toMatchObject({ released: 0, parked: 1 });
      expect(await stateOf(held.id)).toBe("backlog");
      expect(await unblockedWakes(held.id)).toHaveLength(1);
      const again = (await ctx.req("POST", "/api/sweep")).json() as { releasedUnblocked: { released: number; parked: number } };
      expect(again.releasedUnblocked).toMatchObject({ released: 0, parked: 0 });
      expect(await unblockedWakes(held.id)).toHaveLength(1);
      expect((await ctx.db.select().from(decisions)).filter((d) => d.dedupeKey === `unblocked-catchup:${ctx.company.id}`)).toHaveLength(0);
    });
  });

  it("ignores an unknown agent", async () => {
    ctx = await setup();
    await expect(ctx.scheduler.wake({ agentId: randomUUID(), reason: "x" })).rejects.toThrow();
  });

  it("concurrent passes can't launch the same wake twice or overshoot a limit", async () => {
    ctx = await setup({ agent: 1, company: 1 });
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, {});
    await ctx.req("POST", `/api/agents/${worker.id}/wake`, {});
    const results = await Promise.all([ctx.scheduler.tick(), ctx.scheduler.tick(), ctx.scheduler.tick()]);
    expect(results.reduce((n, r) => n + r.launched, 0)).toBe(1);
    expect(ctx.commands).toHaveLength(1);
    const launched = (await ctx.db.select().from(wakes)).filter((w) => w.status === "launched");
    expect(launched).toHaveLength(1);
  });

  it("never holds an owner chat behind the instance or company limit, but one chat per agent at a time", async () => {
    ctx = await setup({ instance: 1, company: 1 });
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "x" });
    await ctx.scheduler.tick();
    expect(ctx.commands).toHaveLength(1); // the one slot is full
    await ctx.scheduler.wake({ agentId: worker.id, reason: "x" });
    await ctx.scheduler.wake({ agentId: worker.id, reason: "owner_chat" });
    await ctx.scheduler.tick();
    expect(ctx.commands).toHaveLength(2); // the chat launched, the work wake still waits
    expect(ctx.commands[1]!.agentId).toBe(worker.id);
    await ctx.scheduler.wake({ agentId: worker.id, reason: "owner_chat", note: "again" });
    await ctx.scheduler.tick();
    expect(ctx.commands).toHaveLength(2); // a second chat for the same agent waits
  });

  it("uses the run limits the owner saved, and rejects a company limit above the instance limit", async () => {
    ctx = await setup({ instance: 1 });
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    const put = (b: object) => ctx!.app.inject({ method: "PUT", url: "/api/run-limits", headers: { cookie: ctx!.cookie }, payload: b });
    expect((await put({ instance: 2, company: 3 })).statusCode).toBe(400);
    expect((await put({ instance: 2, company: 2 })).statusCode).toBe(200);
    expect((await ctx.req("GET", "/api/run-limits")).json()).toMatchObject({ instance: 2, company: 2, defaults: { instance: 8, company: 4 } });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "x" });
    await ctx.scheduler.wake({ agentId: worker.id, reason: "x" });
    await ctx.scheduler.tick();
    expect(ctx.commands).toHaveLength(2); // the test's instance: 1 would have allowed one
  });

  it("starts an urgent ticket even when the agent's older wakes are held by the quota hold (BOS-253)", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    await ctx.req("PATCH", `/api/agents/${worker.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 0.96, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });

    // The agent already has routine wakes held by the quota hold.
    await ctx.scheduler.wake({ agentId: worker.id, ticketId: null, reason: "check due", note: "old" });
    await ctx.scheduler.wake({ agentId: worker.id, ticketId: null, reason: "retro", note: "older" });
    expect(await ctx.tick()).toMatchObject({ launched: 0, deferred: 2 });
    const heldRoutine = (await ctx.db.select().from(wakes)).filter((w) => w.status === "deferred");
    expect(heldRoutine.map((w) => w.reason).sort()).toEqual(["check due", "retro"]);

    // Assigning an urgent ticket gives it its own queued wake, at the high priority.
    const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: worker.id })).json();
    await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
    await ctx.scheduler.notify(worker.id, { ticketId: urgent.id, reason: "assigned", note: "The owner assigned this to you." });
    const own = (await ctx.db.select().from(wakes)).filter((w) => w.ticketId === urgent.id);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ status: "queued" });

    // The next pass launches the urgent ticket; the routine wakes stay held.
    expect(await ctx.tick()).toMatchObject({ launched: 1 });
    expect(ctx.commands.map((c) => c.agentId)).toEqual([worker.id]);
    const after = await ctx.db.select().from(wakes);
    expect(after.filter((w) => w.ticketId === urgent.id)[0]!.runId).toBeTruthy();
    expect(after.filter((w) => w.ticketId === null && w.status === "deferred")).toHaveLength(2);
  });

  it("an urgent ticket's nudge and the owner's message both pass the hold (BOS-253)", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    await ctx.req("PATCH", `/api/agents/${worker.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 0.96, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    await ctx.scheduler.wake({ agentId: worker.id, reason: "retro", note: "older" });
    await ctx.scheduler.tick();

    const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: worker.id })).json();
    await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
    // The assignment's wake starts the work; it ends, and the price is still over the hold.
    expect(await ctx.tick()).toMatchObject({ launched: 1 });
    await ctx.endRun(ctx.commands[0]!.runId);
    await flush();

    // The owner writes on the urgent ticket: the assignee is woken through the hold.
    await ctx.req("POST", `/api/tickets/${urgent.id}/messages`, { text: "pick this up" });
    const own = (await ctx.db.select().from(wakes)).filter((w) => w.ticketId === urgent.id && w.status === "queued");
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ status: "queued" });
    expect(await ctx.tick()).toMatchObject({ launched: 1 });
    await ctx.endRun(ctx.commands[0]!.runId);
    await flush();

    // A nudge about the same urgent ticket also starts the agent, not a held wait.
    const [run] = await ctx.db.select().from(runs).limit(1);
    const res = await ctx.scheduler.nudge({ runId: run!.id, fromAgentId: ctx.ceo.id, to: worker.id, ticketId: urgent.id, why: "Handle this one now, please." });
    expect(res).toMatchObject({ ok: true });
    expect((await ctx.db.select().from(wakes)).find((w) => w.id === (res as { wakeId: string }).wakeId)).toMatchObject({ status: "queued" });
  });

  it("Run now starts a held ticket whose wake was merged into its agent's other held wake (BOS-253)", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    await ctx.req("POST", `/api/companies/${ctx.company.id}/pause`, { paused: true });
    // The agent is already held by its routine work, and the new ticket's wake was merged into that
    // wake (BOS-252): nothing waiting names the ticket.
    await ctx.db.insert(wakes).values({ companyId: ctx.company.id, agentId: ctx.ceo.id, reason: "retro", status: "deferred", statusReason: "subscription seven_day window nearly used up", notBefore: new Date(Date.now() + 3_600_000), priority: 2 });
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Held work", assigneeAgentId: ctx.ceo.id, state: "ready" })).json();
    await ctx.db.update(wakes).set({ ticketId: null }).where(eq(wakes.ticketId, t.id));
    expect((await ctx.db.select().from(wakes)).filter((w) => w.ticketId === t.id)).toHaveLength(0);
    // The page still offers Run now because its agent is held, and Run now starts this ticket.
    const page = (await ctx.req("GET", `/api/tickets/${t.id}`)).json();
    expect(page.quotaHeldUntil).toBeTruthy();
    expect((await ctx.req("POST", `/api/tickets/${t.id}/run-now`)).json()).toEqual({ released: 1 });
    await ctx.req("POST", `/api/companies/${ctx.company.id}/pause`, { paused: false });
    await ctx.tick();
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
  });

  it("server status lists an urgent wake that is waiting, with its ticket and why", async () => {
    ctx = await setup();
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: worker.id })).json();
    await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
    ctx.setOnline(false);
    await ctx.scheduler.notify(worker.id, { ticketId: urgent.id, reason: "assigned", note: "The owner assigned this to you." });
    await ctx.scheduler.tick();
    const status = await ctx.serverStatus.status(ctx.company.id);
    expect(status.wakes.waiting.filter((x) => x.ticketId === urgent.id)).toEqual([expect.objectContaining({ ticketId: urgent.id, urgent: true, agent: "Engineer", held: "runner offline" })]);
  });

  it("holds an urgent ticket assigned after it was marked urgent under the default pause, and shows why (BOS-253)", async () => {
    ctx = await setup({ agent: 5 });
    const sub = (await ctx.req("POST", "/api/funding-sources", { name: "Max", kind: "subscription", provider: "anthropic" })).json();
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    await ctx.req("PATCH", `/api/agents/${worker.id}`, { fundingSourceId: sub.id });
    await ctx.req("POST", "/api/quota-samples", { fundingSourceId: sub.id, claudeMeta: { "_claude/rateLimit": { overageInUse: true, unifiedWindows: { seven_day: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } } });
    // The ticket is made urgent before any wake exists, then assigned: the wake is queued at the
    // usual priority and the quota check still reaches it, so "pause" holds it.
    const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix" })).json();
    await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true, assigneeAgentId: worker.id });
    await ctx.scheduler.notify(worker.id, { ticketId: urgent.id, reason: "assigned", note: "The owner assigned this to you." });
    expect((await ctx.db.select().from(wakes)).filter((w) => w.ticketId === urgent.id)[0]).toMatchObject({ status: "queued", priority: 2 });
    expect(await ctx.tick()).toMatchObject({ launched: 0, deferred: 1 });
    const [held] = (await ctx.db.select().from(wakes)).filter((w) => w.ticketId === urgent.id);
    expect(held!.statusReason).toBe("subscription seven_day window nearly used up");
    const status = await ctx.serverStatus.status(ctx.company.id);
    expect(status.wakes.waiting).toEqual([expect.objectContaining({ ticketId: urgent.id, urgent: true, held: "subscription seven_day window nearly used up" })]);
  });

  describe("two Claude accounts (BOS-383)", () => {
    const meta = (w: number) => ({ "_claude/rateLimit": { unifiedWindows: { seven_day: { utilization: w, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
    async function twoAccounts() {
      ctx = await setup({ agent: 5 });
      const a = (await ctx.req("POST", "/api/funding-sources", { name: "Max one", kind: "subscription", provider: "anthropic", fallbackRank: 1 })).json();
      const sec = (await ctx.req("POST", "/api/secrets", { name: "Max two login", kind: "claude_oauth_token", value: "sk-ant-oat01-abcdefghijklmnop" })).json().secret.id as string;
      const b = (await ctx.req("POST", "/api/funding-sources", { name: "Max two", kind: "subscription", provider: "anthropic", fallbackRank: 2, secretId: sec })).json();
      await ctx.req("PATCH", `/api/agents/${ctx.ceo.id}`, { fundingSourceId: a.id });
      return { a, b };
    }
    const lastRun = async () => (await ctx.db.select().from(runs))[0]!;

    it("starts new runs on the first account while it has room", async () => {
      const { a } = await twoAccounts();
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      expect(await ctx.tick()).toMatchObject({ launched: 1 });
      expect((await lastRun()).fundingSourceId).toBe(a.id);
    });

    it("moves new runs to the second account when the first is full, and tells the owner once", async () => {
      const { a, b } = await twoAccounts();
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      await ctx.tick();
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(0.97) });
      const firstRun = await lastRun();
      await ctx.db.update(runs).set({ endedAt: new Date() }).where(eq(runs.id, firstRun.id));
      await ctx.db.delete(wakes);
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      expect(await ctx.tick()).toMatchObject({ launched: 1 });
      const second = (await ctx.db.select().from(runs)).find((r) => r.id !== firstRun.id)!;
      expect(second.fundingSourceId).toBe(b.id);
      // The run that was already going keeps its account.
      expect((await ctx.db.select().from(runs).where(eq(runs.id, firstRun.id)))[0]!.fundingSourceId).toBe(a.id);
      expect((await ctx.db.select().from(notifications)).filter((n) => /New runs now use Max two/.test(n.title))).toHaveLength(1);
    });

    it("tells the owner once about the switch even when urgent and routine work alternate over several polls (BOS-453)", async () => {
      const { a, b } = await twoAccounts();
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      await ctx.tick();
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(0.97) });
      const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: ctx.ceo.id })).json();
      await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
      for (let i = 0; i < 4; i++) {
        await ctx.db.update(runs).set({ endedAt: new Date() });
        await ctx.db.delete(wakes);
        // An urgent wake passes at 97% and lands on the first account; a routine wake goes to the second.
        await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2, ...(i % 2 ? { ticketId: urgent.id } : {}) });
        await ctx.tick();
      }
      const notes = (await ctx.db.select().from(notifications)).filter((n) => /New runs now use/.test(n.title));
      expect(notes.map((n) => n.title)).toEqual(["New runs now use Max two"]);
    });

    async function twoUrgentAccounts() {
      const { a, b } = await twoAccounts();
      await ctx.req("PATCH", `/api/funding-sources/${a.id}`, { quotaOverage: "urgent" });
      await ctx.req("PATCH", `/api/funding-sources/${b.id}`, { quotaOverage: "urgent" });
      const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: ctx.ceo.id })).json();
      await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
      return { a, b, urgent };
    }

    it("sends an urgent wake to the second account when the first is at 100% and extra usage is on (BOS-463)", async () => {
      const { a, b, urgent } = await twoUrgentAccounts();
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(1) });
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: b.id, claudeMeta: meta(0.09) });
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2, ticketId: urgent.id });
      expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: expect.any(Number) });
      const used = (await ctx.db.select().from(runs)).map((r) => r.fundingSourceId);
      expect(used.length).toBeGreaterThan(0);
      expect(new Set(used)).toEqual(new Set([b.id]));
    });

    it("uses extra usage on the first account only when every account is full (BOS-463)", async () => {
      const { a, b, urgent } = await twoUrgentAccounts();
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(1) });
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: b.id, claudeMeta: meta(1) });
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2, ticketId: urgent.id });
      expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: expect.any(Number) });
      const used = (await ctx.db.select().from(runs)).map((r) => r.fundingSourceId);
      expect(used.length).toBeGreaterThan(0);
      expect(new Set(used)).toEqual(new Set([a.id]));
    });

    it("marks an account full when a run fails with the weekly limit, so the next run goes elsewhere (BOS-463)", async () => {
      const { a, b } = await twoAccounts();
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      await ctx.req("POST", "/api/scheduler/tick");
      const first = await lastRun();
      expect(first.fundingSourceId).toBe(a.id);
      const [runnerRow] = await ctx.db.select().from(runners);
      await ctx.runners.ingest(runnerRow!, { seq: 1, at: new Date().toISOString(), event: { type: "run.ended", runId: first.id, stopReason: null, error: "You've hit your weekly limit · resets Nov 7, 2pm" } });
      await ctx.db.delete(wakes);
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 1 });
      const second = (await ctx.db.select().from(runs)).find((r) => r.id !== first.id)!;
      expect(second.fundingSourceId).toBe(b.id);
    });

    it("holds routine work when every account is full", async () => {
      const { a, b } = await twoAccounts();
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(0.97) });
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: b.id, claudeMeta: meta(0.99) });
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      expect(await ctx.tick()).toMatchObject({ launched: 0, deferred: 1 });
    });

    it("refuses a second account with no login, and skips one whose login was removed", async () => {
      const { a, b } = await twoAccounts();
      const bad = await ctx.req("POST", "/api/funding-sources", { name: "No login", kind: "subscription", provider: "anthropic", fallbackRank: 2 });
      expect(bad.statusCode).toBe(400);
      await ctx.db.update(fundingSources).set({ secretId: null }).where(eq(fundingSources.id, b.id));
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(0.97) });
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      expect(await ctx.tick()).toMatchObject({ launched: 0, deferred: 1 });
    });

    it("releases a wake parked while every account was full once another account has room (BOS-449)", async () => {
      const { a, b } = await twoAccounts();
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(0.97) });
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: b.id, claudeMeta: meta(0.99) });
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 0, deferred: 1 });
      const [parked] = await ctx.db.select().from(wakes);
      expect(parked!.notBefore!.getTime()).toBeGreaterThan(Date.now());
      // The owner adds room: the second account's window resets (its sample is gone).
      await ctx.db.delete(quotaSamples).where(eq(quotaSamples.fundingSourceId, b.id));
      expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 1 });
      expect((await lastRun()).fundingSourceId).toBe(b.id);
    });

    it("says which account was skipped for want of a login when holding", async () => {
      const { a, b } = await twoAccounts();
      await ctx.db.update(fundingSources).set({ secretId: null }).where(eq(fundingSources.id, b.id));
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(0.97) });
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      await ctx.req("POST", "/api/scheduler/tick");
      expect((await ctx.db.select().from(wakes))[0]!.statusReason).toMatch(/Max two skipped: no login/);
    });

    it("sends an urgent wake to the second account when the first is at its limit (BOS-449)", async () => {
      const { a, b } = await twoAccounts();
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(1) });
      const urgent = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Urgent fix", assigneeAgentId: ctx.ceo.id })).json();
      await ctx.req("PATCH", `/api/tickets/${urgent.id}`, { urgent: true });
      await ctx.db.delete(wakes);
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2, ticketId: urgent.id });
      expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 1 });
      expect((await lastRun()).fundingSourceId).toBe(b.id);
    });

    it("ignores a reading whose window reset already passed, and warns when the agent's own account has no order", async () => {
      const { a, b } = await twoAccounts();
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: { "_claude/rateLimit": { unifiedWindows: { five_hour: { utilization: 0, resetsAt: Math.floor(Date.now() / 1000) - 86400 } } } } });
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 1 });
      expect((await lastRun()).fundingSourceId).toBe(a.id);
      await ctx.db.update(runs).set({ endedAt: new Date() });
      await ctx.db.delete(wakes);
      await ctx.db.update(fundingSources).set({ fallbackRank: null }).where(eq(fundingSources.id, a.id));
      await ctx.req("POST", "/api/quota-samples", { fundingSourceId: a.id, claudeMeta: meta(0.97) });
      await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 2 });
      await ctx.req("POST", "/api/scheduler/tick");
      expect((await ctx.db.select().from(wakes))[0]!.statusReason).toMatch(/Max one has no order/);
      expect(b.id).toBeTruthy();
    });

    it("refuses a ranked account that is not a Claude subscription", async () => {
      ctx = await setup({ agent: 5 });
      const res = await ctx.req("POST", "/api/funding-sources", { name: "Plain", kind: "api_credit", provider: "anthropic", fallbackRank: 1 });
      expect(res.statusCode).toBe(400);
    });
  });
});
