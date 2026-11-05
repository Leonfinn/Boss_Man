// One closer for every card Boss Man raises itself (DR-016, BOS-470): a card names what would make
// its cause gone, and the closer closes it, on any tier, with the reason in context.withdrawn.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, fundingSources, quotaSamples, runners, runs as runsTable, tickets, wakes } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Rod" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const commands: RunnerCommand[] = [];
  let release = built.runners.connect(reg.runnerId, (c) => (commands.push(c), true));
  const offline = () => release();
  const online = () => (release = built.runners.connect(reg.runnerId, (c) => (commands.push(c), true)));
  let seq = 0;
  const emit = (event: RunnerEvent) => built.runners.ingest(runnerRow!, { seq: ++seq, at: clock().toISOString(), event });
  const ticket = async (body: Record<string, unknown>) => (await req("POST", `/api/projects/${project.id}/tickets`, body)).json() as { id: string };
  const queue = async () => (await req("GET", "/api/decisions")).json() as Array<{ id: string; kind: string; tier: string; question: string }>;
  const sweep = async () => (await req("POST", "/api/sweep")).json() as { closedCards: number };
  const advance = (ms: number) => (offset += ms);
  return { ...built, db, close, req, company, ceo, worker, project, commands, emit, ticket, queue, sweep, advance, clock, offline, online };
}

describe("one closer for Boss Man's own cards (DR-016, BOS-470)", () => {
  it("closes a stalled-run card by itself once the run speaks again, and records why — on the owner's tier too", async () => {
    ctx = await setup();
    const t = await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.scheduler.tick();
    const start = ctx.commands.find((c) => c.type === "run.start") as Extract<RunnerCommand, { type: "run.start" }>;
    await ctx.emit({ type: "run.started", runId: start.runId, agentId: ctx.ceo.id, acpSessionId: "s1", model: null });
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    const [card] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    expect(card!.status).toBe("open");
    expect((card!.context as { clearWhen?: unknown[] }).clearWhen?.[0]).toMatchObject({ kind: "runActive", runId: start.runId });
    // Put the card on the owner's tier: the closer must not care which rung it is on.
    await ctx.db.update(decisions).set({ tier: "owner" }).where(eq(decisions.id, card!.id));

    ctx.advance(30_000);
    await ctx.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message_chunk" } } as RunnerEvent);
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(after!.status).toBe("withdrawn");
    expect((after!.context as { withdrawn?: { by: string; note: string } }).withdrawn?.by).toBe("system");
    expect((after!.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/active again/i);
    expect(await ctx.queue()).toEqual([]);
    expect((await ctx.db.select().from(activity)).some((a) => a.kind === "decision_withdrawn" && /by itself/.test(a.summary))).toBe(true);
    expect(t.id).toBeTruthy();
  });

  it("closes a usage-limit card once the account has room again", async () => {
    ctx = await setup();
    const [source] = await ctx.db
      .insert(fundingSources)
      .values({ name: "Claude Max", kind: "subscription", provider: "anthropic" })
      .returning();
    // Over the limit, resetting in six hours: no room.
    await ctx.db.insert(quotaSamples).values({ fundingSourceId: source!.id, window: "five_hour", utilization: 1, resetsAt: new Date(ctx.clock().getTime() + 6 * 3_600_000), observedAt: ctx.clock() });
    const [card] = await ctx.db
      .insert(decisions)
      .values({
        companyId: ctx.company.id,
        kind: "question",
        question: "Routine work paused: the Claude Max window is used up.",
        options: ["Got it"],
        recommendedOption: "Got it",
        tier: "owner",
        dedupeKey: `limit:${source!.id}:five_hour`,
        context: { type: "question", clearWhen: [{ kind: "limitReset", fundingSourceId: source!.id }] },
      })
      .returning();
    await ctx.sweep();
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id)))[0]!.status).toBe("open");
    // The window reset: a fresh sample under the threshold (the newest one wins).
    await ctx.db.insert(quotaSamples).values({ fundingSourceId: source!.id, window: "five_hour", utilization: 0.2, resetsAt: new Date(ctx.clock().getTime() + 6 * 3_600_000), observedAt: ctx.clock() });
    await ctx.sweep();
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(after!.status).toBe("withdrawn");
    expect((after!.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/room again/i);
  });

  it("closes a merge-retry card once its ticket is done", async () => {
    ctx = await setup();
    const t = await ctx.ticket({ title: "Fix the footer", assigneeAgentId: ctx.worker.id });
    const [card] = await ctx.db
      .insert(decisions)
      .values({
        companyId: ctx.company.id,
        kind: "question",
        question: `"Fix the footer" was approved, but its merge didn't finish.`,
        options: ["Run the check again", "Send it back"],
        recommendedOption: "Run the check again",
        tier: "owner",
        dedupeKey: `merge-stuck:${t.id}`,
        context: { type: "check_stuck", ticketId: t.id, command: "", output: "stopped", clearWhen: [{ kind: "ticketDone", ticketId: t.id }] },
      })
      .returning();
    await ctx.sweep();
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id)))[0]!.status).toBe("open");
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    await ctx.sweep();
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(after!.status).toBe("withdrawn");
    expect((after!.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/finished/i);
  });

  it("closes a 'could not start … runner offline' card once the runner reconnects and that wake has started, on any tier", async () => {
    ctx = await setup();
    const t = await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    ctx.offline();
    await ctx.scheduler.tick();
    // The scheduler's own raise: a "runner offline" start failure carries the runnerConnected condition.
    const [card] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "question"));
    expect(card!.question).toMatch(/could not start.*runner offline/i);
    expect((card!.context as { clearWhen?: Array<{ kind: string; wakeId?: string }> }).clearWhen?.[0]).toMatchObject({ kind: "runnerConnected", companyId: ctx.company.id });
    // Put it on the owner's tier, as DR-017 E requires it to clear there too.
    await ctx.db.update(decisions).set({ tier: "owner" }).where(eq(decisions.id, card!.id));
    const [wake] = await ctx.db.select().from(wakes).where(eq(wakes.ticketId, t.id));
    // The runner reconnects but the wake hasn't started yet: the card stays (a reconnected runner alone fixes nothing).
    ctx.online();
    await ctx.sweep();
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id)))[0]!.status).toBe("open");
    // The wake starts: the card closes.
    await ctx.scheduler.tick();
    expect((await ctx.db.select().from(wakes).where(eq(wakes.id, wake!.id)))[0]!.runId).toBeTruthy();
    await ctx.sweep();
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(after!.status).toBe("withdrawn");
    expect((after!.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/connected again and the wake has started/i);
  });

  it("closes a self-wake, chain or ticketless alert after the agent's next clean run with no new trip, on any tier", async () => {
    ctx = await setup();
    const c0 = ctx;
    const [dirty] = await ctx.db
      .insert(runsTable)
      .values({ companyId: ctx.company.id, agentId: ctx.worker.id, startedAt: ctx.clock(), endedAt: ctx.clock(), outcome: "error: boom" })
      .returning();
    const [clean] = await ctx.db
      .insert(runsTable)
      .values({ companyId: c0.company.id, agentId: c0.worker.id, startedAt: c0.clock(), endedAt: c0.clock(), outcome: "end_turn" })
      .returning();
    expect(dirty!.outcome).toMatch(/error/);
    const cards = await c0.db
      .insert(decisions)
      .values(
        (["self", "chain", "ticketless"] as const).map((what) => ({
          companyId: c0.company.id,
          kind: "question" as const,
          question: `Rod's ${what} alert`,
          options: ["Got it"],
          recommendedOption: "Got it",
          tier: "owner" as const,
          dedupeKey: `alert:${what}:${c0.worker.id}`,
          createdAt: new Date(clean!.startedAt.getTime() - 60_000),
          context: { type: "question", clearWhen: [{ kind: "agentRanOk", agentId: c0.worker.id }] },
        })),
      )
      .returning();
    await c0.sweep();
    for (const c of cards) expect((await c0.db.select().from(decisions).where(eq(decisions.id, c.id)))[0]!.status).toBe("withdrawn");
    expect((await c0.db.select().from(activity)).filter((a) => a.kind === "decision_withdrawn")).toHaveLength(3);
  });

  it("leaves an agent's own question alone: only a person can tell when that is answered", async () => {
    ctx = await setup();
    const t = await ctx.ticket({ title: "Pick a provider" });
    const card = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.worker.id, question: "Stripe or Mollie?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: t.id, triedFirst: "Compared their fees" });
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    const [row] = await ctx.db.select().from(decisions).where(eq(decisions.id, card.id));
    expect(row!.status).toBe("open");
    expect((row!.context as { clearWhen?: unknown }).clearWhen).toBeUndefined();
  });
});
