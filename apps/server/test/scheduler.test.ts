import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners, runTokens, wakes } from "../src/db/schema.js";
import { hashToken } from "../src/auth.js";
import type { Limits } from "../src/services/scheduler.js";

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

async function setup(limits: Partial<Limits> = {}) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, limits, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  // A fake connected runner that records commands.
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  let online = true;
  built.runners.connect(reg.runnerId, (c) => {
    if (!online) return false;
    if (c.type === "run.start") commands.push(c);
    return true;
  });
  let seq = 0;
  const endRun = (runId: string) => built.runners.ingest(runnerRow!, { seq: ++seq, at: new Date().toISOString(), event: { type: "run.ended", runId, stopReason: "end_turn", error: null } });
  const setOnline = (v: boolean) => (online = v);
  return { ...built, db, close, req, company, ceo, project, commands, endRun, setOnline };
}

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("scheduler", () => {
  it("launches an assigned ticket with a prompt and a working MCP token, one run per agent at a time", async () => {
    ctx = await setup();
    const t1 = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Checkout error states", assigneeAgentId: ctx.ceo.id })).json();
    await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Load test", assigneeAgentId: ctx.ceo.id });

    const first = (await ctx.req("POST", "/api/scheduler/tick")).json();
    expect(first).toMatchObject({ launched: 1, waiting: 1 });
    const cmd = ctx.commands[0]!;
    expect(cmd).toMatchObject({ agentId: ctx.ceo.id, agentKind: "claude", cwd: `/ws/${t1.id}` });
    expect(cmd.prompt).toContain("Checkout error states");
    expect(cmd.prompt).toContain("set_ticket_state");
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
    await ctx.req("POST", "/api/kill-switch", { paused: true });
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ paused: true, launched: 0 });
    await ctx.req("POST", "/api/kill-switch", { paused: false });
    await ctx.req("POST", `/api/companies/${ctx.company.id}/pause`, { paused: true });
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 0, waiting: 1 });
    await ctx.req("POST", `/api/companies/${ctx.company.id}/pause`, { paused: false });
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 1 });
  });

  it("waits while the runner is offline", async () => {
    ctx = await setup();
    ctx.setOnline(false);
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, {});
    await ctx.req("POST", "/api/scheduler/tick");
    const [w] = await ctx.db.select().from(wakes);
    expect(w).toMatchObject({ status: "queued", statusReason: "runner offline" });
    ctx.setOnline(true);
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 1 });
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

  it("caps an agent's runs with no ticket, but never the owner's own (R68)", async () => {
    ctx = await setup();
    for (let i = 0; i < 6; i++) await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "decision", note: `d${i}` });
    const seventh = await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "decision", note: "d6" });
    expect(seventh).toMatchObject({ status: "dropped", statusReason: "more than 6 wakes with no ticket in an hour" });
    await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "decision", note: "d7" });
    // The owner hears once, not for every dropped wake.
    const alerts = (await ctx.db.select().from(decisions)).filter((d) => /with no ticket/.test(d.question));
    expect(alerts).toHaveLength(1);
    // The owner's own wake and ticket work still go through.
    expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "woken by owner" })).toMatchObject({ status: "queued" });
    const t = (await ctx.req("POST", `/api/projects/${ctx.project.id}/tickets`, { title: "Real work" })).json();
    expect(await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "assigned", ticketId: t.id })).toMatchObject({ status: "queued" });
  });

  it("defers when a pausing budget is exceeded, failing closed", async () => {
    ctx = await setup();
    const fs = (await ctx.req("POST", "/api/funding-sources", { name: "API", kind: "api_payg", provider: "anthropic" })).json();
    await ctx.req("POST", "/api/budget-policies", { scopeKind: "company", scopeId: ctx.company.id, windowKind: "lifetime", limitUsd: 1, onLimit: "pause" });
    await ctx.req("POST", "/api/cost-events", { fundingSourceId: fs.id, companyId: ctx.company.id, costUsd: 2 });
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, {});
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 0, deferred: 1 });
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
    expect((await ctx.req("POST", "/api/scheduler/tick")).json()).toMatchObject({ launched: 1, deferred: 1 });
    const low = (await ctx.db.select().from(wakes)).find((w) => w.priority === 2)!;
    expect(low.status).toBe("deferred");
    expect(low.notBefore?.getTime()).toBe(resets * 1000);
  });

  it("launches higher priority first when capacity is short", async () => {
    ctx = await setup({ instance: 1 });
    const worker = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Engineer" })).json();
    await ctx.req("POST", `/api/agents/${ctx.ceo.id}/wake`, { priority: 1, note: "low" });
    await ctx.req("POST", `/api/agents/${worker.id}/wake`, { priority: 4, note: "urgent" });
    await ctx.req("POST", "/api/scheduler/tick");
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.commands[0]!.prompt).toContain("urgent");
  });

  it("wakes the agent that asked once the owner answers", async () => {
    ctx = await setup();
    const d = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Which DNS provider?", options: ["deSEC", "Cloudflare"], recommended: "deSEC" });
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "deSEC" });
    // It waits a moment for more answers (R68); move past that.
    await ctx.db.update(wakes).set({ notBefore: new Date(Date.now() - 1000) }).where(eq(wakes.reason, "decision answered"));
    await ctx.req("POST", "/api/scheduler/tick");
    expect(ctx.commands[0]!.prompt).toContain('The owner answered your question "Which DNS provider?": deSEC');
  });

  it("gives an agent several answers in a row in one run, not one run each (R68)", async () => {
    ctx = await setup();
    const ask = (question: string) => ctx!.decisions.raise({ companyId: ctx!.company.id, agentId: ctx!.ceo.id, question, options: ["Yes", "No"], recommended: "Yes" });
    const [a, b, c] = [await ask("Mission?"), await ask("Objectives?"), await ask("Research first?")];
    await ctx.req("POST", `/api/decisions/${a.id}/answer`, { answer: "Yes" });
    await ctx.req("POST", "/api/scheduler/tick");
    expect(ctx.commands).toEqual([]);
    const [first] = await ctx.db.select().from(wakes).where(eq(wakes.reason, "decision answered"));
    expect(first).toMatchObject({ status: "deferred", statusReason: "waiting briefly for more answers" });
    expect(first!.notBefore!.getTime() - Date.now()).toBeGreaterThan(100_000);

    // Each answer waits again, but never more than five minutes after the first.
    await ctx.db.update(wakes).set({ createdAt: new Date(Date.now() - 4 * 60_000), notBefore: new Date(Date.now() - 2 * 60_000) }).where(eq(wakes.id, first!.id));
    await ctx.req("POST", `/api/decisions/${b.id}/answer`, { answer: "No" });
    await ctx.req("POST", `/api/decisions/${c.id}/answer`, { answer: "Yes" });
    const all = await ctx.db.select().from(wakes).where(eq(wakes.reason, "decision answered"));
    expect(all).toHaveLength(1);
    expect(Math.abs(all[0]!.notBefore!.getTime() - (Date.now() + 60_000))).toBeLessThan(5_000);

    await ctx.db.update(wakes).set({ notBefore: new Date(Date.now() - 1000) }).where(eq(wakes.id, first!.id));
    await ctx.req("POST", "/api/scheduler/tick");
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
});
