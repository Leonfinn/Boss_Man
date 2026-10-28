import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runsService } from "../src/services/runs.js";
import { activity, agents, decisions, notifications, runs, runners, tickets, wakes } from "../src/db/schema.js";

const HOUR = 3_600_000;
let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

type Row = { id: string; kind: string; question: string; recommendedOption: string; score: number; reasons: string[]; blocks: Array<{ ticketId: string; depth: number }>; dueDate: string | null };

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const commands: RunnerCommand[] = [];
  let release = built.runners.connect(reg.runnerId, (c) => (commands.push(c), true));
  const offline = () => release();
  const online = () => (release = built.runners.connect(reg.runnerId, (c) => (commands.push(c), true)));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: clock().toISOString(), event });
  const ticket = async (body: Record<string, unknown>) => (await req("POST", `/api/projects/${project.id}/tickets`, body)).json() as { id: string };
  const queue = async () => (await req("GET", "/api/decisions")).json() as Row[];
  const sweep = async () => (await req("POST", "/api/sweep")).json() as { staleBlockers: { open: number; raised: number }; stalledRuns: { open: number; raised: number }; lostRuns: number };
  const advance = (ms: number) => (offset += ms);
  return { ...built, db, close, req, company, ceo, worker, project, commands, emit, ticket, queue, sweep, advance, clock, offline, online };
}

describe("ranked decision queue (R20)", () => {
  it("ranks by what a decision holds up, with the chain and reasons", async () => {
    ctx = await setup();
    const obj = (await ctx.req("POST", `/api/companies/${ctx.company.id}/objectives`, { title: "Launch the app", priority: 1 })).json();
    const kr = (await ctx.req("POST", `/api/objectives/${obj.id}/key-results`, { title: "Checkout works", target: 1 })).json();
    const tomorrow = new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 10);
    const checkout = await ctx.ticket({ title: "Checkout", keyResultId: kr.id, dueDate: tomorrow });
    const release = await ctx.ticket({ title: "Release" });
    await ctx.req("POST", `/api/tickets/${release.id}/dependencies`, { ticketId: checkout.id });

    // The older question blocks nothing; the newer one holds up P1 work due tomorrow.
    const idle = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Team name?", options: ["A", "B"], recommended: "A" });
    const key = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Which payment provider?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: checkout.id });

    const q = await ctx.queue();
    expect(q.map((r) => r.id)).toEqual([key.id, idle.id]);
    expect(q[0]!.blocks).toEqual([expect.objectContaining({ ticketId: checkout.id, depth: 1 }), expect.objectContaining({ ticketId: release.id, depth: 2 })]);
    expect(q[0]!.dueDate).toBe(tomorrow);
    expect(q[0]!.reasons).toEqual(expect.arrayContaining(["Blocks 1 ticket directly and 1 more down the chain", "Holds up P1 objective work", "Due in 1 day"]));
    expect(q[1]!.score).toBeLessThan(q[0]!.score);
  });

  it("links the tickets a card is about and the references in its text, in its own company only", async () => {
    ctx = await setup();
    const restore = await ctx.ticket({ title: "Restore proof" });
    const release = await ctx.ticket({ title: "Release" });
    await ctx.req("POST", `/api/tickets/${release.id}/dependencies`, { ticketId: restore.id });
    const [rt] = await ctx.db.select().from(tickets).where(eq(tickets.id, restore.id));
    const ref = `${(await ctx.req("GET", "/api/companies")).json().find((c: { id: string }) => c.id === ctx.company.id).ticketPrefix ?? "APP"}-${rt!.number}`;
    const other = (await ctx.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    const otherProject = (await ctx.req("POST", `/api/companies/${other.company.id}/projects`, { name: "Elsewhere" })).json() as { id: string };
    const foreign = (await ctx.req("POST", `/api/projects/${otherProject.id}/tickets`, { title: "Secret" })).json() as { id: string };
    const [ft] = await ctx.db.select().from(tickets).where(eq(tickets.id, foreign.id));
    const d = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: `Needs a run (${ref}). Not ${ref.split("-")[0]}-999 or OTH-${ft!.number}.`, options: ["Done", "No"], recommended: "Done", blocksTicketId: restore.id });
    const row = (await ctx.queue()).find((r) => r.id === d.id) as Row & { about: Array<{ ticketId: string; ref: string }>; refs: Record<string, { ticketId: string }> };
    expect(row.about).toEqual([expect.objectContaining({ ticketId: restore.id, ref })]);
    expect(row.blocks.map((b) => b.ticketId)).toEqual([restore.id, release.id]);
    expect(Object.keys(row.refs)).toEqual([ref]);
    expect(row.refs[ref]!.ticketId).toBe(restore.id);
  });

  it("links the ticket a ticket_cap or lesson card is about, even when it holds nothing up or is done", async () => {
    ctx = await setup();
    const capped = await ctx.ticket({ title: "Capped work" });
    const finished = await ctx.ticket({ title: "Finished work" });
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, finished.id));
    const mk = async (question: string, context: Record<string, unknown>) =>
      (await ctx.db.insert(decisions).values({ companyId: ctx.company.id, kind: "approval", question, options: ["Yes", "No"], recommendedOption: "Yes", context: context as never }).returning())[0]!;
    const cap = await mk("Raise the cap?", { type: "ticket_cap", ticketId: capped.id });
    const deployed = await mk("Review the result?", { type: "risk_review", ticketId: finished.id, reviewer: "x" });
    const q = (await ctx.queue()) as Array<Row & { about: Array<{ ticketId: string; title: string }> }>;
    expect(q.find((r) => r.id === cap.id)!.about.map((a) => a.ticketId)).toEqual([capped.id]);
    expect(q.find((r) => r.id === deployed.id)!.about).toEqual([expect.objectContaining({ ticketId: finished.id, title: "Finished work" })]);
  });

  it("links the tickets a hire is for, and shows nothing for a card with no ticket", async () => {
    ctx = await setup();
    const waiting = await ctx.ticket({ title: "Waiting for a designer" });
    const mk = async (question: string, context: Record<string, unknown>) =>
      (await ctx.db.insert(decisions).values({ companyId: ctx.company.id, kind: "approval", question, options: ["Yes", "No"], recommendedOption: "Yes", context: context as never }).returning())[0]!;
    const hire = await mk("Hire a designer?", { type: "hire", proposal: { name: "Dee", forTickets: [waiting.id, "not-an-id"] }, byAgentId: ctx.ceo.id });
    const bare = await mk("Hire anyone?", { type: "hire", proposal: { name: "Eve" }, byAgentId: ctx.ceo.id });
    const q = (await ctx.queue()) as Array<Row & { about: Array<{ ticketId: string }> }>;
    expect(q.find((r) => r.id === hire.id)!.about.map((a) => a.ticketId)).toEqual([waiting.id]);
    expect(q.find((r) => r.id === bare.id)!.about).toEqual([]);
  });

  it("keeps a ticket blocked while it still waits on something else", async () => {
    ctx = await setup();
    const design = await ctx.ticket({ title: "Design" });
    const build = await ctx.ticket({ title: "Build", state: "blocked" });
    await ctx.req("POST", `/api/tickets/${build.id}/dependencies`, { ticketId: design.id });
    const d = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: null, question: "Colour scheme?", options: ["Dark", "Light"], recommended: "Dark", blocksTicketId: build.id });
    await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Dark" });
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, build.id));
    expect(t!.systemState).toBe("blocked");
  });
});

describe("stale blockers (R21)", () => {
  async function blockedPair(blockerAssignee: string | null) {
    const domain = await ctx.ticket({ title: "Buy domain", ...(blockerAssignee ? { assigneeAgentId: blockerAssignee } : {}) });
    const tls = await ctx.ticket({ title: "Set up TLS", state: "blocked", assigneeAgentId: ctx.worker.id });
    await ctx.req("POST", `/api/tickets/${tls.id}/dependencies`, { ticketId: domain.id });
    await ctx.db.delete(wakes);
    return { domain, tls };
  }

  it("flags a blocker idle past the threshold once, and chasing wakes its assignee and restarts the clock", async () => {
    ctx = await setup();
    const { domain } = await blockedPair(ctx.ceo.id);
    expect((await ctx.sweep()).staleBlockers.raised).toBe(0);

    ctx.advance(25 * HOUR);
    expect((await ctx.sweep()).staleBlockers).toEqual({ open: 1, raised: 1 });
    expect((await ctx.sweep()).staleBlockers.raised).toBe(0); // no duplicate
    const [row] = (await ctx.queue()).filter((r) => r.kind === "stale_blocker");
    expect(row!.question).toBe('"Buy domain" (assigned to CEO) has blocked "Set up TLS" with no activity for 25 hours.');
    expect(row!.recommendedOption).toBe("Chase");

    await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Chase" });
    const woken = await ctx.db.select().from(wakes);
    expect(woken).toEqual([expect.objectContaining({ agentId: ctx.ceo.id, ticketId: domain.id, reason: "chased", priority: 3 })]);
    expect((await ctx.sweep()).staleBlockers.open).toBe(0);

    // Still idle a day later: flagged again.
    ctx.advance(25 * HOUR);
    expect((await ctx.sweep()).staleBlockers.raised).toBe(1);
  });

  it("recommends reassigning an unowned blocker and needs someone to hand it to", async () => {
    ctx = await setup();
    const { domain } = await blockedPair(null);
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    const [row] = await ctx.queue();
    expect(row!.recommendedOption).toBe("Reassign");
    const noPick = await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Reassign" });
    expect(noPick.statusCode).toBe(422);
    expect(noPick.body).toContain("Pick who should take this ticket.");
    expect(noPick.body).not.toContain("assigneeAgentId");
    expect((await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Reassign", assigneeAgentId: ctx.worker.id })).statusCode).toBe(200);
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, domain.id));
    expect(t!.assigneeAgentId).toBe(ctx.worker.id);
    expect(await ctx.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: ctx.worker.id, reason: "assigned" })]);
  });

  it("Let the CEO decide takes the card off the owner's queue and wakes the CEO, who can then reassign it", async () => {
    ctx = await setup();
    const { domain } = await blockedPair(ctx.worker.id);
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    const [row] = await ctx.queue();
    const [stored] = await ctx.db.select().from(decisions).where(eq(decisions.id, row!.id));
    expect(stored!.options).toContain("Let the CEO decide");
    const r = await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Let the CEO decide" });
    expect(r.statusCode).toBe(200);
    expect(await ctx.queue()).toEqual([]);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.id, row!.id));
    expect(d).toMatchObject({ status: "open", tier: "ceo" });
    expect((d!.context as { ladder: { rung: string } }).ladder.rung).toBe("ceo");
    expect(await ctx.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: ctx.ceo.id, reason: "decision" })]);
    expect((await ctx.sweep()).staleBlockers.raised).toBe(0); // not raised a second time

    // The CEO's answer carries out the owner's options.
    const done = await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Reassign", assigneeAgentId: ctx.ceo.id });
    expect(done.statusCode).toBe(200);
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, domain.id));
    expect(t!.assigneeAgentId).toBe(ctx.ceo.id);
  });

  it("won't reassign to an agent from another company", async () => {
    ctx = await setup();
    const { domain } = await blockedPair(ctx.worker.id);
    const other = (await ctx.req("POST", "/api/companies", { name: "Other Co" })).json() as { ceo: { id: string } };
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    const [row] = await ctx.queue();
    const r = await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Reassign", assigneeAgentId: other.ceo.id });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain("Pick someone from the list");
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, domain.id));
    expect(t!.assigneeAgentId).toBe(ctx.worker.id);
  });

  it("refuses to hand the card to the CEO when the company has none", async () => {
    ctx = await setup();
    await blockedPair(ctx.worker.id);
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    const [row] = await ctx.queue();
    await ctx.db.update(agents).set({ role: "worker" }).where(eq(agents.id, ctx.ceo.id));
    const r = await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Let the CEO decide" });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain("no CEO");
    expect(await ctx.queue()).toHaveLength(1);
  });

  it("dropping the dependency frees the waiting ticket", async () => {
    ctx = await setup();
    const { tls } = await blockedPair(ctx.ceo.id);
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    const [row] = await ctx.queue();
    await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Drop dependency" });
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, tls.id));
    expect(t!.systemState).toBe("ready");
    expect(await ctx.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: ctx.worker.id, ticketId: tls.id, reason: "unblocked" })]);
  });

  it("withdraws the row once the blocker is done", async () => {
    ctx = await setup();
    const { domain } = await blockedPair(ctx.ceo.id);
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    await ctx.req("PATCH", `/api/tickets/${domain.id}`, { state: "done" });
    await ctx.sweep();
    expect(await ctx.queue()).toEqual([]);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stale_blocker"));
    expect(d).toMatchObject({ status: "withdrawn", dedupeKey: null });
  });
});

describe("stalled runs (R32)", () => {
  async function launch() {
    const t = await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.scheduler.tick();
    const start = ctx.commands.find((c) => c.type === "run.start") as Extract<RunnerCommand, { type: "run.start" }>;
    await ctx.emit({ type: "run.started", runId: start.runId, agentId: ctx.ceo.id, acpSessionId: "s1", model: null });
    return { ticket: t, runId: start.runId };
  }

  it("advises after a silence, and cancels only if the owner says so", async () => {
    ctx = await setup();
    const { runId } = await launch();
    ctx.advance(4 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
    ctx.advance(2 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(1);
    const [row] = await ctx.queue();
    expect(row).toMatchObject({ kind: "stalled_run", recommendedOption: "Keep waiting" });
    expect(row!.question).toBe('CEO has sent nothing for 6 minutes while working on "Checkout error states". It may be stuck, or busy with a long command.');
    expect(ctx.commands.some((c) => c.type === "run.cancel")).toBe(false);

    await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Cancel run" });
    expect(ctx.commands.at(-1)).toEqual({ type: "run.cancel", runId });
  });

  it("says when a run never started, and recommends cancelling it", async () => {
    ctx = await setup();
    await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.scheduler.tick();
    ctx.advance(6 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(1);
    const [row] = await ctx.queue();
    expect(row).toMatchObject({ kind: "stalled_run", recommendedOption: "Cancel run" });
    expect(row!.question).toBe(`CEO's run on "Checkout error states" never started: the runner hasn't reported it beginning in 6 minutes, probably because the runner restarted. Cancel it, then message CEO on the task to start again.`);
  });

  it("withdraws when the run speaks again, and says nothing more after keep waiting", async () => {
    ctx = await setup();
    const { runId } = await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    await ctx.emit({ type: "run.update", runId, update: { sessionUpdate: "agent_message_chunk" } } as RunnerEvent);
    await ctx.sweep();
    expect(await ctx.queue()).toEqual([]);

    ctx.advance(6 * 60_000);
    await ctx.sweep();
    const [row] = await ctx.queue();
    await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Keep waiting" });
    ctx.advance(10 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
  });

  it("asks again 30 minutes after keep waiting if the run is still quiet, one open alert at a time", async () => {
    ctx = await setup();
    await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    const [row] = await ctx.queue();
    await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Keep waiting" });
    ctx.advance(29 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
    ctx.advance(2 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(1);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
    expect(await ctx.queue()).toHaveLength(1);
  });

  it("closes the alert when the run's ticket is already done", async () => {
    ctx = await setup();
    const { ticket } = await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    expect(await ctx.queue()).toHaveLength(1);
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, ticket.id));
    await ctx.sweep();
    expect(await ctx.queue()).toEqual([]);
  });

  it("links a stall notice to its run and a stale blocker to the blocked ticket", async () => {
    ctx = await setup();
    const { runId } = await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    const domain = await ctx.ticket({ title: "Buy domain" });
    const tls = await ctx.ticket({ title: "Set up TLS", state: "blocked", assigneeAgentId: ctx.worker.id });
    await ctx.req("POST", `/api/tickets/${tls.id}/dependencies`, { ticketId: domain.id });
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    await ctx.notes.syncDecisions();
    const links = Object.fromEntries((await ctx.db.select({ k: decisions.kind, l: notifications.link }).from(notifications).innerJoin(decisions, eq(decisions.id, notifications.decisionId))).map((r) => [r.k, r.l]));
    expect(links).toMatchObject({ stalled_run: `#/runs/${runId}`, stale_blocker: `#/tickets/${tls.id}` });
  });

  it("attaches evidence to a quiet run: last step, runner state, and what it waits on", async () => {
    ctx = await setup();
    const { runId, ticket } = await launch();
    await ctx.emit({ type: "run.update", runId, update: { kind: "tool_call", title: "Run npm test", status: "in_progress" } } as unknown as RunnerEvent);
    ctx.advance(14 * 60_000);
    await ctx.sweep();
    const [row] = (await ctx.queue()) as Array<Row & { evidence: Record<string, any> }>;
    expect(row!.evidence).toMatchObject({ runId, agent: "CEO", ticketId: ticket.id, ticket: "Checkout error states", runner: { connected: true }, waitingOnOwner: false });
    expect(row!.evidence.lastStep).toMatchObject({ type: "run.update", event: { update: { title: "Run npm test" } } });
    expect(new Date(row!.evidence.lastEventAt).getTime()).toBeLessThan(Date.now() + 1000);
    ctx.offline();
    const [off] = (await ctx.queue()) as Array<Row & { evidence: Record<string, any> }>;
    expect(off!.evidence.runner.connected).toBe(false);
  });

  it("attaches evidence to a run that never started: no events at all", async () => {
    ctx = await setup();
    await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.scheduler.tick();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    const [row] = (await ctx.queue()) as Array<Row & { evidence: Record<string, any> }>;
    expect(row!.evidence).toMatchObject({ lastEventAt: null, lastStep: null, ticket: "Checkout error states" });
  });

  it("doesn't flag a run that is waiting for a permission answer", async () => {
    ctx = await setup();
    const { runId } = await launch();
    await ctx.emit({ type: "run.permission_request", runId, requestId: "r1", title: "git push", kind: "execute", rawInput: { command: "git push origin main" }, options: [] } as unknown as RunnerEvent);
    const open = await ctx.db.select().from(decisions).where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open")));
    expect(open).toHaveLength(1);
    ctx.advance(30 * 60_000);
    expect((await ctx.sweep()).stalledRuns.open).toBe(0);
    // The paused agent outranks other rows.
    expect((await ctx.queue())[0]!.reasons[0]).toBe("An agent is paused until you answer");
  });

  it("drops a run's open permission request from the queue when the run ends", async () => {
    ctx = await setup();
    const { runId } = await launch();
    await ctx.emit({ type: "run.permission_request", runId, requestId: "r1", title: "git push", kind: "execute", rawInput: { command: "git push origin main" }, options: [] } as unknown as RunnerEvent);
    expect(await ctx.queue()).toHaveLength(1);
    await ctx.emit({ type: "run.ended", runId, stopReason: "cancelled", error: null });
    expect(await ctx.queue()).toEqual([]);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "permission"));
    expect(d!.status).toBe("withdrawn");
  });
});

describe("the server ends runs it can't reach", () => {
  async function launched() {
    const t = await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.scheduler.tick();
    const start = ctx.commands.find((c) => c.type === "run.start") as Extract<RunnerCommand, { type: "run.start" }>;
    await ctx.emit({ type: "run.started", runId: start.runId, agentId: ctx.ceo.id, acpSessionId: "s1", model: null });
    return { ticket: t, runId: start.runId };
  }
  const row = async (runId: string) => (await ctx.db.select().from(runs).where(eq(runs.id, runId)))[0]!;

  it("stop with the runner offline ends the run here and runs the end handling", async () => {
    ctx = await setup();
    const { runId } = await launched();
    ctx.offline();
    expect((await ctx.req("POST", `/api/runs/${runId}/cancel`)).json()).toEqual({ cancelled: true, endedHere: true });
    expect(await row(runId)).toMatchObject({ outcome: "stopped: runner offline", endedAt: expect.any(Date) });
    expect((await ctx.db.select().from(activity)).some((a) => a.kind === "run_ended" && a.summary.includes("stopped: runner offline"))).toBe(true);
  });

  it("cancelling a stalled run from the alert with the runner offline says so", async () => {
    ctx = await setup();
    const { runId } = await launched();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    const [d] = await ctx.queue();
    ctx.offline();
    expect((await ctx.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Cancel run" })).json()).toMatchObject({ delivered: false, endedHere: true });
    expect((await row(runId)).outcome).toBe("stopped: runner offline");
  });

  it("with the runner online, ends the run if no run.ended arrives within a minute", async () => {
    ctx = await setup();
    const { runId } = await launched();
    expect((await ctx.req("POST", `/api/runs/${runId}/cancel`)).json()).toEqual({ cancelled: true });
    ctx.advance(30_000);
    await ctx.sweep();
    expect((await row(runId)).endedAt).toBeNull();
    ctx.advance(31_000);
    await ctx.sweep();
    expect(await row(runId)).toMatchObject({ outcome: "stopped: runner didn't confirm", endedAt: expect.any(Date) });
  });

  it("a cancel survives a restart: a fresh service on the same database still ends the run", async () => {
    ctx = await setup();
    const { runId } = await launched();
    await ctx.req("POST", `/api/runs/${runId}/cancel`);
    expect((await row(runId)).cancelRequestedAt).toBeInstanceOf(Date);
    const restarted = runsService(ctx.db, { runners: ctx.runners, now: ctx.clock });
    await restarted.endUnconfirmedCancels(new Date(ctx.clock().getTime() + 61_000));
    expect(await row(runId)).toMatchObject({ outcome: "stopped: runner didn't confirm", endedAt: expect.any(Date) });
  });

  it("leaves a confirmed cancel alone", async () => {
    ctx = await setup();
    const { runId } = await launched();
    await ctx.req("POST", `/api/runs/${runId}/cancel`);
    await ctx.emit({ type: "run.ended", runId, stopReason: "cancelled", error: null });
    ctx.advance(2 * 60_000);
    await ctx.sweep();
    expect((await row(runId)).outcome).toBe("cancelled");
  });

  it("reaps a run whose runner has been offline well past the stall limit, and withdraws its alert", async () => {
    ctx = await setup();
    const { runId } = await launched();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    expect(await ctx.queue()).toHaveLength(1);
    ctx.offline();
    ctx.advance(28 * 60_000);
    expect((await ctx.sweep()).lostRuns).toBe(0); // 34 minutes in: not yet 30 past the 5-minute limit
    ctx.advance(2 * 60_000);
    const res = await ctx.sweep();
    expect(res.lostRuns).toBe(1);
    expect(await row(runId)).toMatchObject({ outcome: "lost: runner offline" });
    expect(await ctx.queue()).toEqual([]);
  });

  it("never reaps a run on a connected runner that has sent events", async () => {
    ctx = await setup();
    const { runId } = await launched();
    ctx.advance(3 * HOUR);
    expect((await ctx.sweep()).lostRuns).toBe(0);
    expect((await row(runId)).endedAt).toBeNull();
  });
});
