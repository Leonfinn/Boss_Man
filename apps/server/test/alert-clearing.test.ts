// One closer for every card Boss Man raises itself (DR-016, BOS-470): a card names what would make
// its cause gone, and the closer closes it, on any tier, with the reason in context.withdrawn.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { clearWhenOf } from "../src/services/alert-clearing.js";
import { activity, decisions, fundingSources, notifications, quotaSamples, runners, runs as runsTable, ticketDependencies, tickets, wakes } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(o: { trustedProxies?: string[]; fetch?: typeof fetch } = {}) {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock, ...o });
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

  it("closes when any one condition is true, not only when all of them are", async () => {
    ctx = await setup();
    const t = await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.scheduler.tick();
    const start = ctx.commands.find((c) => c.type === "run.start") as Extract<RunnerCommand, { type: "run.start" }>;
    await ctx.emit({ type: "run.started", runId: start.runId, agentId: ctx.ceo.id, acpSessionId: "s1", model: null });
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    const [card] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    // Two conditions: the run stirring, or the ticket finishing. The ticket is NOT done here.
    expect((card!.context as { clearWhen?: unknown[] }).clearWhen).toHaveLength(2);
    const [before] = await ctx.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(before!.systemState).not.toBe("done");

    // Only the first is true (the run speaks again): the card still closes, so "any one" is meant.
    ctx.advance(30_000);
    await ctx.emit({ type: "run.update", runId: start.runId, update: { kind: "agent_message_chunk" } } as RunnerEvent);
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(after!.status).toBe("withdrawn");
    expect((after!.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/active again/i);
    expect((after!.context as { withdrawn?: { note: string } }).withdrawn?.note).not.toMatch(/finished/i);
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

  it("leaves an auth-error card open while the account has room in its quota windows, and closes it only on a clean run on that account (BOS-469, security review)", async () => {
    ctx = await setup();
    const [source] = await ctx.db
      .insert(fundingSources)
      .values({ name: "Claude Max", kind: "subscription", provider: "anthropic" })
      .returning();
    // A revoked key leaves the quota windows empty: "room again" is true at once, which is not proof.
    await ctx.db.insert(quotaSamples).values({ fundingSourceId: source!.id, window: "five_hour", utilization: 0.1, resetsAt: new Date(ctx.clock().getTime() + 6 * 3_600_000), observedAt: ctx.clock() });
    const [card] = await ctx.db
      .insert(decisions)
      .values({
        companyId: ctx.company.id,
        kind: "question",
        question: "Brains has hit the same failure 3 times: identity verification is required.",
        options: ["Got it"],
        recommendedOption: "Got it",
        tier: "owner",
        dedupeKey: `account:${ctx.company.id}:${source!.id}:account_limit`,
        context: { type: "question", decisionsKind: "alert:account_limit", clearWhen: [{ kind: "accountRanOk", fundingSourceId: source!.id }] },
      })
      .returning();
    await ctx.sweep();
    expect((await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id)))[0]!.status).toBe("open");
    // A run on the account that finished cleanly proves the credential works again.
    const start = ctx.clock();
    await ctx.db.insert(runsTable).values({ id: crypto.randomUUID(), companyId: ctx.company.id, agentId: ctx.worker.id, fundingSourceId: source!.id, startedAt: start, endedAt: new Date(start.getTime() + 60_000), outcome: "end_turn" });
    await ctx.sweep();
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, card!.id));
    expect(after!.status).toBe("withdrawn");
    expect((after!.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/succeeded/i);
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
    // Since BOS-480 the scheduler raises no card for "runner offline" (the runner watch, BOS-467, is that alert).
    expect(await ctx.db.select().from(decisions).where(eq(decisions.kind, "question"))).toEqual([]);
    const [wake] = await ctx.db.select().from(wakes).where(eq(wakes.ticketId, t.id));
    // Cards raised before BOS-480 are still open on live data, so the closer must still clear them.
    // Shape as flagFailedStart raised it, on the owner's tier, as DR-017 E requires it to clear there too.
    const [card] = await ctx.db
      .insert(decisions)
      .values({
        companyId: ctx.company.id,
        kind: "question",
        question: `Ceo could not start on "Checkout error states" (wake: assigned): runner offline. Boss Man will keep trying; look into it if the reason does not clear.`,
        options: ["Got it"],
        recommendedOption: "Got it",
        tier: "owner",
        dedupeKey: `start-fail:${ctx.ceo.id}:${wake!.id}`,
        context: { type: "question", clearWhen: [{ kind: "runnerConnected", companyId: ctx.company.id, wakeId: wake!.id }] },
      })
      .returning();
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

describe("an add-on's setup card closes itself once the add-on works (DR-023 D, BOS-522)", () => {
  const raiseSetup = async (c: NonNullable<typeof ctx>, ticketId: string) =>
    c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Put Boss Man behind Tailscale?", options: ["Done", "Not now"], recommended: "Done", blocksTicketId: ticketId, triedFirst: "No host access from a runner", steps: ["Install Tailscale on the server."], setsUp: "tailscale" });
  const row = async (c: NonNullable<typeof ctx>, id: string) => (await c.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;

  it("stays open on a Tailscale reading from before the card, closes after a request through the edge, frees the ticket and tells the owner", async () => {
    // Inject's peer is 127.0.0.1, so naming it as the edge makes every request "through Tailscale".
    ctx = await setup({ trustedProxies: ["127.0.0.1"] });
    const t = await ctx.ticket({ title: "Reach Boss Man from the phone", assigneeAgentId: ctx.worker.id });
    ctx.advance(60_000);
    const card = await raiseSetup(ctx, t.id);
    expect((await row(ctx, card.id)).context).toMatchObject({ setsUp: "tailscale", clearWhen: [{ kind: "addonRunning", addon: "tailscale" }] });
    const [held] = await ctx.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(held!.systemState).toBe("blocked");

    // Tailscale reads running from the setup requests, but those came before the card: not proof it's fixed.
    await ctx.sweeps.run();
    expect((await row(ctx, card.id)).status).toBe("open");

    ctx.advance(60_000);
    await ctx.req("GET", "/api/decisions");
    await ctx.sweeps.run();
    const after = await row(ctx, card.id);
    expect(after.status).toBe("withdrawn");
    expect((after.context as { withdrawn?: { by: string; note: string } }).withdrawn).toMatchObject({ by: "system", note: expect.stringMatching(/^Tailscale is running \(last request through the trusted edge/) });
    // The ticket no longer waits on it.
    expect(await ctx.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, card.id))).toEqual([]);
    const [freed] = await ctx.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(freed!.systemState).toBe("ready");
    // The owner reads it on the ticket's activity and under "Settled or withdrawn by the team".
    expect((await ctx.db.select().from(activity)).some((a) => a.kind === "decision_withdrawn" && a.ticketId === t.id && /by itself: Tailscale is running/.test(a.summary))).toBe(true);
    const advised = (await ctx.req("GET", "/api/decisions/advised")).json() as Array<{ id: string; withdrawn?: { by: string; note: string } }>;
    expect(advised.find((a) => a.id === card.id)?.withdrawn).toMatchObject({ by: "Boss Man", note: expect.stringMatching(/Tailscale is running/) });
  });

  it("stays open while the add-on isn't running, however many requests come in", async () => {
    ctx = await setup();
    const t = await ctx.ticket({ title: "Reach Boss Man from the phone", assigneeAgentId: ctx.worker.id });
    const card = await raiseSetup(ctx, t.id);
    ctx.advance(60_000);
    await ctx.req("GET", "/api/decisions");
    await ctx.sweeps.run();
    expect((await row(ctx, card.id)).status).toBe("open");
    const [held] = await ctx.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(held!.systemState).toBe("blocked");
  });

  it("keeps an ntfy setup card open while ntfy is not set up, unknown or stopped, and closes it once a push goes through", async () => {
    // No push may leave the test: any the app sends get a 200 here.
    ctx = await setup({ fetch: async () => new Response("", { status: 200 }) });
    const t = await ctx.ticket({ title: "Phone pushes", assigneeAgentId: ctx.worker.id });
    const card = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.worker.id, question: "Turn on phone pushes?", options: ["Done", "Not now"], recommended: "Done", blocksTicketId: t.id, triedFirst: "Needs the owner's phone", steps: ["Install the ntfy app."], setsUp: "ntfy" });
    const status = async () => (await row(ctx!, card.id)).status;
    const push = { requested: "page", level: "page", title: "x", link: "#/decisions" } as const;

    await ctx.sweeps.run(); // not_set_up
    expect(await status()).toBe("open");
    await ctx.notes.setSettings({ ...(await ctx.notes.getSettings()), ntfy: { url: "https://ntfy.example", topic: "bm", tokenSecretId: null } });
    await ctx.sweeps.run(); // unknown: set up, nothing pushed yet
    expect(await status()).toBe("open");
    ctx.advance(60_000);
    await ctx.db.insert(notifications).values({ ...push, createdAt: ctx.clock(), pushError: "ntfy answered 401" });
    await ctx.sweeps.run(); // stopped
    expect(await status()).toBe("open");

    ctx.advance(60_000);
    await ctx.db.insert(notifications).values({ ...push, createdAt: ctx.clock(), pushedAt: ctx.clock() });
    await ctx.sweeps.run(); // running, after the card
    const after = await row(ctx, card.id);
    expect(after.status).toBe("withdrawn");
    expect((after.context as { withdrawn?: { by: string; note: string } }).withdrawn).toMatchObject({ by: "system", note: expect.stringMatching(/^ntfy is running \(ntfy accepted the last push, which doesn't show the phone got it, at \d\d:\d\d\)$/) });
    const [freed] = await ctx.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(freed!.systemState).toBe("ready");
  });

  it("ignores an add-on name it doesn't know rather than guess", () => {
    expect(clearWhenOf({ clearWhen: [{ kind: "addonRunning", addon: "grafana" }, { kind: "addonRunning", addon: "ntfy" }] })).toEqual([{ kind: "addonRunning", addon: "ntfy" }]);
  });
});
