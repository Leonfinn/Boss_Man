import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners, tickets, wakes } from "../src/db/schema.js";

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
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws", now: clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const commands: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (commands.push(c), true));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: clock().toISOString(), event });
  const ticket = async (body: Record<string, unknown>) => (await req("POST", `/api/projects/${project.id}/tickets`, body)).json() as { id: string };
  const queue = async () => (await req("GET", "/api/decisions")).json() as Row[];
  const sweep = async () => (await req("POST", "/api/sweep")).json() as { staleBlockers: { open: number; raised: number }; stalledRuns: { open: number; raised: number } };
  const advance = (ms: number) => (offset += ms);
  return { ...built, db, close, req, company, ceo, worker, project, commands, emit, ticket, queue, sweep, advance, clock };
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
    expect((await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Reassign" })).statusCode).toBe(422);
    expect((await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Reassign", assigneeAgentId: ctx.worker.id })).statusCode).toBe(200);
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, domain.id));
    expect(t!.assigneeAgentId).toBe(ctx.worker.id);
    expect(await ctx.db.select().from(wakes)).toEqual([expect.objectContaining({ agentId: ctx.worker.id, reason: "assigned" })]);
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
});
