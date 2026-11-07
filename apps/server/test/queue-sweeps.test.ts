import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, getTableName, inArray, ne, sql } from "drizzle-orm";
import type { RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite, type Db } from "../src/db/client.js";
import { runsService } from "../src/services/runs.js";
import { decisionsService } from "../src/services/decisions.js";
import { HELD_AGENT } from "../src/services/fair-share.js";
import { effectiveDueDate, rankDecision, ticketRef, type BlockedTicket } from "@boss-man/shared";
import { activity, agents, companies, decisions, keyResults, milestones, notifications, objectives, runs, runners, skillProposals, ticketDependencies, tickets, wakes } from "../src/db/schema.js";

const HOUR = 3_600_000;
let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

type Row = { id: string; kind: string; question: string; recommendedOption: string; score: number; reasons: string[]; blocks: Array<{ ticketId: string; depth: number }>; dueDate: string | null };

/** Wraps a db so every select made while `reads.on` is set is counted, with the rows it returned (BOS-409). */
function countReads(inner: Db) {
  const reads = { on: false, queries: 0, rows: 0, byTable: {} as Record<string, number> };
  const wrap = (b: object, table = ""): object =>
    new Proxy(b, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v !== "function") return v;
        if (prop === "then")
          return (ok?: (r: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            v.call(target, (r: unknown) => {
              if (reads.on && Array.isArray(r)) {
                reads.queries++;
                reads.rows += r.length;
                reads.byTable[table] = (reads.byTable[table] ?? 0) + r.length;
              }
              return ok ? ok(r) : r;
            }, bad);
        return (...a: unknown[]) => {
          const out = v.apply(target, a);
          const from = prop === "from" ? getTableName(a[0] as never) : table;
          return out && typeof out === "object" ? wrap(out, from) : out;
        };
      },
    });
  const db = new Proxy(inner, { get: (t, p) => (p === "select" ? (...a: unknown[]) => wrap((t.select as (...x: unknown[]) => object)(...a)) : Reflect.get(t, p, t)) }) as Db;
  return { db, reads };
}

async function setup() {
  const { db: rawDb, close } = await openPglite();
  const { db, reads } = countReads(rawDb);
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
  // A stalled-run card climbs the alert ladder now (DR-017): it belongs to the Scrum Master/CEO, never the
  // owner's queue unless it is an owner kind. These tests read the card itself, whatever rung holds it, in
  // the CEO's own view (which carries the same evidence and reasons the owner's queue shows).
  const alerts = async () => (await built.decisions.queue({ includeAll: true, companyId: company.id })) as unknown as Row[];
  const sweep = async () => (await req("POST", "/api/sweep")).json() as { staleBlockers: { open: number; raised: number }; stalledRuns: { open: number; raised: number }; neverStartedRuns: number; lostRuns: number; longTicketlessRuns: { raised: number } };
  const advance = (ms: number) => (offset += ms);
  return { ...built, db, reads, close, req, company, ceo, worker, project, commands, emit, ticket, queue, alerts, sweep, advance, clock, offline, online };
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

  it("lists the newest card first even when an older one scores higher", async () => {
    ctx = await setup();
    const checkout = await ctx.ticket({ title: "Checkout" });
    const urgent = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Which payment provider?", options: ["Stripe", "Mollie"], recommended: "Stripe", blocksTicketId: checkout.id });
    ctx.advance(HOUR);
    const idle = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Team name?", options: ["A", "B"], recommended: "A" });

    const q = await ctx.queue();
    expect(q.map((r) => r.id)).toEqual([idle.id, urgent.id]);
    expect(q[0]!.score).toBeLessThan(q[1]!.score);
  });

  describe("do-this-next ordering and the waiting group (BOS-551)", () => {
    type Ordered = Row & { step?: number | null; waiting?: string | null; doAfter?: string[]; doBefore?: string[] };
    const ordered = async () => (await ctx.queue()) as unknown as Ordered[];

    it("numbers hands-on cards and puts them in do-this-next order, respecting do after / do before", async () => {
      ctx = await setup();
      const q = (await ctx.queue()) as unknown as Ordered[];
      expect(q).toEqual([]);
      // Three cards that all need the owner's hands, raised newest-first: update, measure, setup.
      const setupCard = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Turn on ntfy", options: ["Done", "Skip"], recommended: "Done", steps: ["Open Settings → Add-ons → ntfy."] });
      ctx.advance(HOUR);
      const measure = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Read the memory figure", options: ["Done", "Skip"], recommended: "Done", steps: ["Read the memory figure in Settings."] });
      ctx.advance(HOUR);
      // The update must happen after the measurement (a restart resets the reading), expressed as doAfter on the update.
      const update = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Update to ad845180", options: ["Done", "Skip"], recommended: "Done", steps: ["Apply the update."], doAfter: [{ decisionId: measure.id, label: "Read the memory figure" }] });
      ctx.advance(HOUR);
      // The setup must happen before the measurement.
      await ctx.db.update(decisions).set({ context: sql`${decisions.context} || '{"doBefore":[{"decisionId":"${sql.raw(measure.id)}","label":"Read the memory figure"}]}'::jsonb` }).where(eq(decisions.id, setupCard.id));

      const rows = (await ordered()).filter((r) => !r.waiting);
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set([setupCard.id, measure.id, update.id]));
      // Measurement and update: the measure (step before update) plus an independent setup.
      const step = (id: string) => rows.find((r) => r.id === id)!.step!;
      expect(step(measure.id)).toBeLessThan(step(update.id));
      expect(step(setupCard.id)).toBeLessThan(step(measure.id));
      expect(rows).toEqual([...rows].sort((a, b) => a.step! - b.step!));
      // Labels show on the card that has the link.
      expect(rows.find((r) => r.id === update.id)!.doAfter).toEqual(["Read the memory figure"]);
    });

    it("keeps today's newest-first order for cards with no ordering info, and never numbers cards that need no hands-on work", async () => {
      ctx = await setup();
      const older = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Team name?", options: ["A", "B"], recommended: "A" });
      ctx.advance(HOUR);
      const newer = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Which domain?", options: ["A", "B"], recommended: "A" });
      const rows = (await ordered()).filter((r) => !r.waiting);
      expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
      expect(rows.every((r) => r.step == null)).toBe(true);
    });

    it("puts a card the owner already acted on into the waiting group at the bottom, with a reason", async () => {
      ctx = await setup();
      const hands = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Read the memory figure", options: ["Done", "Skip"], recommended: "Done", steps: ["Read the memory figure in Settings."] });
      const stale = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Approve the budget?", options: ["Approve", "No"], recommended: "Approve" });
      await ctx.db.update(decisions).set({ staleAt: ctx.clock(), staleReason: "you changed it" }).where(eq(decisions.id, stale.id));

      const rows = await ordered();
      // The waiting card is last, is marked, and the hands-on card is numbered.
      expect(rows[rows.length - 1]!.id).toBe(stale.id);
      expect(rows[rows.length - 1]!.waiting).toMatch(/checking whether this is still needed/i);
      expect(rows[0]!.id).toBe(hands.id);
      expect(rows[0]!.step).toBe(1);
    });

    it("puts a card whose ticket is back with an agent into the waiting group, with the reason", async () => {
      ctx = await setup();
      const hands = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Read the memory figure", options: ["Done", "Skip"], recommended: "Done", steps: ["Read the memory figure in Settings."] });
      // A merge card whose check failed: the ticket went back to the agent (in progress).
      const ticket = await ctx.ticket({ title: "Ship the invoicing page", state: "in_progress", assigneeAgentId: ctx.worker.id });
      const [sentBack] = await ctx.db.insert(decisions).values({ companyId: ctx.company.id, kind: "approval", tier: "owner", question: "Merge and ship?", options: ["Run the check again", "Send it back to the agent"], recommendedOption: "Run the check again", context: { type: "check_stuck", ticketId: ticket.id, command: "scripts/check-all.sh", output: "failed" } as never }).returning();

      const rows = await ordered();
      const w = rows.find((r) => r.id === sentBack!.id)!;
      expect(w.waiting).toMatch(/merge check failed/i);
      expect(w.waiting).toMatch(/Engineer/);
      // It is last, and the hands-on card keeps its step.
      expect(rows[rows.length - 1]!.id).toBe(sentBack!.id);
      expect(rows.find((r) => r.id === hands.id)!.step).toBe(1);
    });

    it("never folds a hands-on card into the waiting group just because its ticket is in progress (BOS-551 follow-up)", async () => {
      ctx = await setup();
      // A memory reading the owner must take before a server update that resets it. Its ticket is in
      // progress (an agent may hold it while the owner's card is open: starting a ticket ignores decision
      // blockers), so a naive "in progress means waiting" rule would hide it behind the update.
      const ticket = await ctx.ticket({ title: "Take the memory reading", state: "in_progress", assigneeAgentId: ctx.worker.id });
      const measure = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Read the memory figure", options: ["Done", "Skip"], recommended: "Done", steps: ["Read the memory figure in Settings."], blocksTicketId: ticket.id });
      // The question above blocks its ticket; the reading must still keep its buttons.
      await ctx.db.update(tickets).set({ systemState: "in_progress" }).where(eq(tickets.id, ticket.id));
      ctx.advance(HOUR);
      const update = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Update to ad845180", options: ["Done", "Skip"], recommended: "Done", steps: ["Apply the update."], doAfter: [{ decisionId: measure.id, label: "Read the memory figure" }] });
      // A separate merge card whose ticket genuinely went back to an agent (in progress).
      const mergeTicket = await ctx.ticket({ title: "Ship the invoicing page", state: "in_progress", assigneeAgentId: ctx.worker.id });
      const [sentBack] = await ctx.db.insert(decisions).values({ companyId: ctx.company.id, kind: "approval", tier: "owner", question: "Merge and ship?", options: ["Run the check again", "Send it back to the agent"], recommendedOption: "Run the check again", context: { type: "check_stuck", ticketId: mergeTicket.id, command: "scripts/check-all.sh", output: "failed" } as never }).returning();

      const rows = await ordered();
      const reading = rows.find((r) => r.id === measure.id)!;
      const upd = rows.find((r) => r.id === update.id)!;
      // The reading has answer buttons: it is not in the waiting group, and it is numbered before the update.
      expect(reading.waiting).toBeUndefined();
      expect(reading.step).toBe(1);
      expect(upd.waiting).toBeUndefined();
      expect(upd.doAfter).toEqual(["Read the memory figure"]);
      expect(reading.step!).toBeLessThan(upd.step!);
      // The merge card still waits: it is the only one folded, and it is last.
      expect(rows.find((r) => r.id === sentBack!.id)!.waiting).toMatch(/merge check failed/i);
      expect(rows[rows.length - 1]!.id).toBe(sentBack!.id);
    });

    it("orders a card that carries a do-after link even when it needs no hands-on work, but never numbers it", async () => {
      ctx = await setup();
      const measure = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Read the memory figure", options: ["Done", "Skip"], recommended: "Done", steps: ["Read the memory figure in Settings."] });
      ctx.advance(HOUR);
      // An approval that needs no steps, but must come after the measurement.
      const approve = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Approve the budget?", options: ["Approve", "No"], recommended: "Approve", doAfter: [{ decisionId: measure.id, label: "Read the memory figure" }] });
      const rows = (await ordered()).filter((r) => !r.waiting);
      // The measurement (hands-on) is numbered and comes before the linked approval.
      expect(rows.find((r) => r.id === measure.id)!.step).toBe(1);
      expect(rows.find((r) => r.id === approve.id)!.step).toBeUndefined();
      expect(rows.findIndex((r) => r.id === measure.id)).toBeLessThan(rows.findIndex((r) => r.id === approve.id));
      expect(rows.find((r) => r.id === approve.id)!.doAfter).toEqual(["Read the memory figure"]);
    });

    it("breaks a cycle rather than looping, still ordering every card once", async () => {
      ctx = await setup();
      const a = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "A", options: ["Done", "Skip"], recommended: "Done", steps: ["Step A."] });
      const b = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "B", options: ["Done", "Skip"], recommended: "Done", steps: ["Step B."] });
      // A after B, and B after A: a cycle.
      await ctx.db.update(decisions).set({ context: sql`${decisions.context} || '{"doAfter":[{"decisionId":"${sql.raw(b.id)}","label":"B"}]}'::jsonb` }).where(eq(decisions.id, a.id));
      await ctx.db.update(decisions).set({ context: sql`${decisions.context} || '{"doAfter":[{"decisionId":"${sql.raw(a.id)}","label":"A"}]}'::jsonb` }).where(eq(decisions.id, b.id));
      const rows = (await ordered()).filter((r) => !r.waiting);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.step))).toEqual(new Set([1, 2]));
    });

    it("drops do after / do before links to another company's open card (BOS-625)", async () => {
      ctx = await setup();
      const other = (await ctx.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string }; ceo: { id: string } };
      const foreign = await ctx.decisions.raise({ companyId: other.company.id, agentId: other.ceo.id, question: "Elsewhere's card", options: ["Yes", "No"], recommended: "Yes" });
      const mine = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "My card", options: ["Done", "Skip"], recommended: "Done", doAfter: [{ decisionId: foreign.id, label: "Elsewhere's card" }], doBefore: [{ decisionId: foreign.id, label: "Elsewhere's card" }] });
      // The raiser is told which links weren't stored, and why.
      expect(mine.droppedLinks).toEqual([
        { decisionId: foreign.id, link: "doAfter", reason: "another company" },
        { decisionId: foreign.id, link: "doBefore", reason: "another company" },
      ]);
      const [row] = await ctx.db.select().from(decisions).where(eq(decisions.id, mine.id));
      const c = row!.context as { doAfter?: unknown[]; doBefore?: unknown[] };
      expect(c.doAfter ?? []).toEqual([]);
      expect(c.doBefore ?? []).toEqual([]);
      // A clean card of my own is still stored and shown, and nothing is reported dropped.
      const keeps = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Second card", options: ["Done", "Skip"], recommended: "Done", steps: ["Do it."], doAfter: [{ decisionId: mine.id, label: "My card" }] });
      expect(keeps.droppedLinks).toEqual([]);
      const [kept] = await ctx.db.select().from(decisions).where(eq(decisions.id, keeps.id));
      expect((kept!.context as { doAfter?: unknown[] }).doAfter).toEqual([{ decisionId: mine.id, label: "My card" }]);
    });

    it("drops do after / do before links to an answered card in the same company (BOS-625)", async () => {
      ctx = await setup();
      const done = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Answered", options: ["Yes", "No"], recommended: "Yes" });
      await ctx.req("POST", `/api/decisions/${done.id}/answer`, { answer: "Yes" });
      const mine = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Late card", options: ["Done", "Skip"], recommended: "Done", doAfter: [{ decisionId: done.id, label: "Answered" }] });
      // The raiser is told which link wasn't stored, and why; an unknown id is reported too.
      expect(mine.droppedLinks).toEqual([{ decisionId: done.id, link: "doAfter", reason: "not open" }]);
      const ghost = randomUUID();
      const nobody = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Ghost card", options: ["Done", "Skip"], recommended: "Done", doAfter: [{ decisionId: ghost, label: "Ghost" }] });
      expect(nobody.droppedLinks).toEqual([{ decisionId: ghost, link: "doAfter", reason: "unknown" }]);
      const [row] = await ctx.db.select().from(decisions).where(eq(decisions.id, mine.id));
      expect((row!.context as { doAfter?: unknown[] }).doAfter ?? []).toEqual([]);
    });
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

  /** Makes `ticketId` the open security-review task of a skill proposal (BOS-176). */
  async function reviewTaskFor(ticketId: string) {
    const [p] = await ctx.db
      .insert(skillProposals)
      .values({ companyId: ctx.company.id, name: "tidy", source: "draft", files: [{ path: "SKILL.md", content: "" }], fileHashes: {}, bundleHash: "b".repeat(64), why: "x", hasScripts: false, reviewRequired: true })
      .returning({ id: skillProposals.id });
    await ctx.db.update(skillProposals).set({ status: "in_review", reviewTicketId: ticketId }).where(eq(skillProposals.id, p!.id));
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
    // The sweep also asked the CEO to hand out work, as the worker had nothing to do (BOS-615).
    expect(await ctx.db.select().from(wakes).where(ne(wakes.reason, "idle agents"))).toEqual([expect.objectContaining({ agentId: ctx.worker.id, reason: "assigned" })]);
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

  it("refuses a Reassign that would move an open skill-review task (BOS-176)", async () => {
    ctx = await setup();
    const { domain } = await blockedPair(ctx.worker.id);
    await reviewTaskFor(domain.id);
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    const [row] = await ctx.queue();
    // The owner hands the card to the CEO, who then tries to reassign the review task.
    expect((await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Let the CEO decide" })).statusCode).toBe(200);
    const svc = decisionsService(ctx.db, () => true, ctx.clock);
    const before = await ctx.db.select().from(wakes);
    await expect(svc.answer(row!.id, "Reassign", { assigneeAgentId: ctx.worker.id, settledBy: { agentId: ctx.ceo.id } })).rejects.toThrow("only the Security Reviewer and the owner");
    // The refusal changed nothing: the review task keeps its assignee and nobody was woken.
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, domain.id));
    expect(t!.assigneeAgentId).toBe(ctx.worker.id);
    expect(await ctx.db.select().from(wakes)).toEqual(before);
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, row!.id));
    expect(after!.status).toBe("open");
  });

  it("lets the owner reassign an open skill-review task from the card, as the guard does", async () => {
    ctx = await setup();
    const { domain } = await blockedPair(null);
    await reviewTaskFor(domain.id);
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    const [row] = await ctx.queue();
    expect((await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Reassign", assigneeAgentId: ctx.worker.id })).statusCode).toBe(200);
    const [t] = await ctx.db.select().from(tickets).where(eq(tickets.id, domain.id));
    expect(t!.assigneeAgentId).toBe(ctx.worker.id);
  });

  it("a CEO agent can't hand the card back to itself to keep it off the owner's queue", async () => {
    ctx = await setup();
    await blockedPair(ctx.worker.id);
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    const [row] = await ctx.queue();
    await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Let the CEO decide" });
    const [before] = await ctx.db.select().from(decisions).where(eq(decisions.id, row!.id));
    ctx.advance(10 * 60 * 1000);
    const svc = decisionsService(ctx.db, () => true, ctx.clock);
    await expect(svc.answer(row!.id, "Let the CEO decide", { settledBy: { agentId: ctx.ceo.id } })).rejects.toThrow("Only the owner");
    const [after] = await ctx.db.select().from(decisions).where(eq(decisions.id, row!.id));
    expect((after!.context as { ladder: { since: string } }).ladder.since).toBe((before!.context as { ladder: { since: string } }).ladder.since);
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

  it("withdraws the row once the blocked ticket is done, and flags only the live pairs (BOS-409)", async () => {
    ctx = await setup();
    const a = await blockedPair(ctx.ceo.id);
    const other = await ctx.ticket({ title: "Get certs", assigneeAgentId: ctx.ceo.id });
    const waiting = await ctx.ticket({ title: "Ship site", state: "blocked", assigneeAgentId: ctx.worker.id });
    await ctx.req("POST", `/api/tickets/${waiting.id}/dependencies`, { ticketId: other.id });
    ctx.advance(25 * HOUR);
    expect((await ctx.sweep()).staleBlockers).toEqual({ open: 2, raised: 2 });
    await ctx.req("PATCH", `/api/tickets/${a.tls.id}`, { state: "done" });
    expect((await ctx.sweep()).staleBlockers).toEqual({ open: 1, raised: 0 });
    const open = await ctx.db.select().from(decisions).where(and(eq(decisions.kind, "stale_blocker"), eq(decisions.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0]!.question).toContain("Get certs");
  });

  it("reads the same rows however many done tickets or unrelated runs exist, and a fixed number of queries per live dependency count (BOS-409)", async () => {
    ctx = await setup();
    const measure = async () => {
      ctx.reads.queries = 0;
      ctx.reads.rows = 0;
      ctx.reads.byTable = {};
      ctx.reads.on = true;
      await ctx.sweep();
      ctx.reads.on = false;
      return { queries: ctx.reads.queries, deps: ctx.reads.byTable["ticket_dependencies"] ?? 0, runs: ctx.reads.byTable["runs"] ?? 0 };
    };
    const pair = async (title: string) => {
      const blocker = await ctx.ticket({ title: `Blocker ${title}`, assigneeAgentId: ctx.ceo.id });
      const waiting = await ctx.ticket({ title: `Waiting ${title}`, state: "blocked", assigneeAgentId: ctx.worker.id });
      await ctx.req("POST", `/api/tickets/${waiting.id}/dependencies`, { ticketId: blocker.id });
      return { blocker, waiting };
    };
    await pair("a");
    await pair("b");
    // The worker is paused so the idle-agents ask to the CEO (BOS-615), whose reads depend on whether the
    // worker is idle (the done tickets below queue wakes for it), stays out of the count.
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.worker.id));
    ctx.advance(25 * HOUR);
    await ctx.sweep(); // raises both cards, so the measured passes are steady-state
    const two = await measure();

    // Done tickets with dependencies, and runs on tickets nobody is waiting on, must not be read.
    let loose = { id: "" };
    for (let i = 0; i < 4; i++) {
      const { waiting } = await pair(`done${i}`);
      await ctx.req("PATCH", `/api/tickets/${waiting.id}`, { state: "done" });
      loose = waiting;
    }
    const at = ctx.clock();
    for (let i = 0; i < 6; i++) await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: ctx.worker.id, ticketId: loose.id, status: "succeeded", startedAt: at, lastEventAt: at, endedAt: at } as never);
    expect(await measure()).toEqual(two);

    // More live dependencies add no queries: blockers and engagements are fetched in one query each.
    for (let i = 0; i < 6; i++) await pair(`live${i}`);
    ctx.advance(25 * HOUR);
    await ctx.sweep();
    const eight = await measure();
    expect(eight.queries).toBe(two.queries);
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
    const [row] = await ctx.alerts();
    expect(row).toMatchObject({ kind: "stalled_run", recommendedOption: "Keep waiting" });
    expect(row!.question).toBe('CEO has sent nothing for 6 minutes while working on "Checkout error states". It may be stuck, or busy with a long command.');
    expect(ctx.commands.some((c) => c.type === "run.cancel")).toBe(false);

    await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Cancel run" });
    expect(ctx.commands.at(-1)).toEqual({ type: "run.cancel", runId });
  });

  it("leaves a never-started run alone while the runner has only just reconnected (BOS-331)", async () => {
    ctx = await setup();
    await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.scheduler.tick();
    ctx.advance(6 * 60_000);
    expect(await ctx.sweep()).toMatchObject({ stalledRuns: { raised: 0 }, neverStartedRuns: 0 });
    const status = (await ctx.serverStatus.status(ctx.company.id)) as { runner: { swapping: boolean } | null };
    expect(status.runner?.swapping).toBe(true);
  });

  describe("runs that never start (BOS-480)", () => {
  const starts = () => ctx.commands.filter((c): c is Extract<RunnerCommand, { type: "run.start" }> => c.type === "run.start");
  const runRow = async (runId: string) => (await ctx.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
  /** A runner past its settling time, as after a restart some while ago, with a known boot. */
  async function settled() {
    ctx = await setup();
    await ctx.db.update(runners).set({ bootId: "boot-1" });
    ctx.advance(11 * 60_000);
  }

  it("ends a never-started run on a connected, settled runner and queues its wake again within 4 minutes, with no card", async () => {
    await settled();
    const t = await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.scheduler.tick();
    const first = starts().at(-1)!;
    const [original] = await ctx.db.select().from(wakes).where(eq(wakes.runId, first.runId));
    ctx.advance(2 * 60_000);
    expect((await ctx.sweep()).neverStartedRuns).toBe(0);
    expect((await runRow(first.runId)).endedAt).toBeNull();
    ctx.advance(60_000);
    expect((await ctx.sweep()).neverStartedRuns).toBe(1);
    expect(await runRow(first.runId)).toMatchObject({ outcome: "lost: never started", endedAt: expect.any(Date) });
    // The runner is told to drop it, in case it is still setting it up.
    expect(ctx.commands).toContainEqual({ type: "run.cancel", runId: first.runId });
    const again = (await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id))).filter((w) => w.id !== original!.id && w.note?.includes("the earlier start never began"));
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ ticketId: t.id, reason: original!.reason, priority: original!.priority, resumeRunId: original!.resumeRunId, causedByRunId: null });
    expect(again[0]!.note).toBe(`${original!.note ? `${original!.note}\n\n` : ""}[Boss Man started this again: the earlier start never began (retry 1 of 2)]`);
    expect(await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"))).toEqual([]);
    // Nothing is asked of anyone, even well past the stall limit.
    ctx.advance(10 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
  });

  it("keeps a resumed run's resume link through the retry", async () => {
    await settled();
    const t = await ctx.ticket({ title: "Checkout error states" });
    const [old] = await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: ctx.worker.id, ticketId: t.id, startedAt: ctx.clock(), endedAt: ctx.clock(), outcome: "interrupted" }).returning();
    await ctx.scheduler.wake({ agentId: ctx.worker.id, ticketId: t.id, reason: "resume", priority: 3, note: "Picks up.", resumeRunId: old!.id });
    await ctx.scheduler.tick();
    const first = starts().at(-1)!;
    ctx.advance(3 * 60_000);
    await ctx.sweep();
    const again = (await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.worker.id))).filter((w) => w.runId !== first.runId);
    expect(again).toEqual([expect.objectContaining({ reason: "resume", priority: 3, resumeRunId: old!.id, note: "Picks up.\n\n[Boss Man started this again: the earlier start never began (retry 1 of 2)]" })]);
  });

  it("leaves alone a run the runner says is waiting for the repo lock", async () => {
    await settled();
    await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.ceo.id });
    await ctx.scheduler.tick();
    const { runId } = starts().at(-1)!;
    await ctx.emit({ type: "runner.log", level: "info", message: `Run ${runId} is waiting for the repo lock before it can start; trying again until it frees.` });
    ctx.advance(20 * 60_000);
    expect((await ctx.sweep()).neverStartedRuns).toBe(0);
    expect((await runRow(runId)).endedAt).toBeNull();
  });

  it("after two retries, the third failure is one CEO card per runner boot listing every agent, which never asks to cancel", async () => {
    await settled();
    const designer = (await ctx.req("POST", `/api/companies/${ctx.company.id}/agents`, { name: "Designer" })).json() as { id: string };
    await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.worker.id });
    await ctx.ticket({ title: "Login page", assigneeAgentId: designer.id });
    const card = async () => ctx.db.select().from(decisions).where(eq(decisions.dedupeKey, `runner-boot:${(await ctx.db.select().from(runners))[0]!.id}:boot-1`));
    const live = async (agentId: string) => (await ctx.db.select().from(runs).where(and(eq(runs.agentId, agentId)))).filter((r) => !r.endedAt);
    for (let round = 1; round <= 3; round++) {
      await ctx.scheduler.tick();
      expect(await live(ctx.worker.id)).toHaveLength(1);
      expect(await live(designer.id)).toHaveLength(1);
      expect(await card()).toEqual([]);
      ctx.advance(3 * 60_000);
      expect((await ctx.sweep()).neverStartedRuns).toBe(2);
    }
    const cards = await card();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.question).toBe(
      `2 runs never started on the runner, even after Boss Man started each again 2 times: Engineer on "Checkout error states"; Designer on "Login page". Boss Man has stopped trying. Check the runner (Settings → Server and runner), then wake these agents again.`,
    );
    // Raised at the CEO (DR-017 A), and never a "Cancel it" card.
    expect((cards[0]!.context as { ladder: { rung: string } }).ladder.rung).toBe("ceo");
    expect(await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"))).toEqual([]);
    // No fourth try.
    await ctx.scheduler.tick();
    expect(await live(ctx.worker.id)).toEqual([]);
    expect(await live(designer.id)).toEqual([]);
  });

  it("a 'runner offline' launch failure raises no card, and the wake still starts once the runner is back", async () => {
    ctx = await setup();
    ctx.offline();
    const t = await ctx.ticket({ title: "Checkout error states", assigneeAgentId: ctx.worker.id });
    await ctx.scheduler.tick();
    await ctx.scheduler.tick();
    const [w] = await ctx.db.select().from(wakes).where(eq(wakes.ticketId, t.id));
    expect(w).toMatchObject({ status: "queued", statusReason: "runner offline" });
    expect(await ctx.db.select().from(decisions)).toEqual([]);
    ctx.online();
    await ctx.scheduler.tick();
    expect(starts().filter((s) => s.agentId === ctx.worker.id)).toHaveLength(1);
    expect(await ctx.db.select().from(decisions)).toEqual([]);
  });
  });

  it("withdraws when the run speaks again, and says nothing more after keep waiting", async () => {
    ctx = await setup();
    const { runId } = await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    await ctx.emit({ type: "run.update", runId, update: { sessionUpdate: "agent_message_chunk" } } as RunnerEvent);
    await ctx.sweep();
    expect(await ctx.alerts()).toEqual([]);

    ctx.advance(6 * 60_000);
    await ctx.sweep();
    const [row] = await ctx.alerts();
    await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Keep waiting" });
    ctx.advance(10 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
  });

  it("asks again 30 minutes after keep waiting if the run is still quiet, one open alert at a time", async () => {
    ctx = await setup();
    await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    const [row] = await ctx.alerts();
    await ctx.req("POST", `/api/decisions/${row!.id}/answer`, { answer: "Keep waiting" });
    ctx.advance(29 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
    ctx.advance(2 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(1);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
    expect(await ctx.alerts()).toHaveLength(1);
  });

  it("closes the alert when the run's ticket is already done", async () => {
    ctx = await setup();
    const { ticket } = await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    expect(await ctx.alerts()).toHaveLength(1);
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, ticket.id));
    await ctx.sweep();
    expect(await ctx.alerts()).toEqual([]);
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
    // A stall notice stops at the CEO now (DR-017), so put it where the owner would see it (as the ladder does on
    // a timeout or the CEO's escalate) to check the link it carries. The chain is unchanged.
    await ctx.db.update(decisions).set({ tier: "owner", context: sql`jsonb_set(${decisions.context}, '{ladder,rung}', '"owner"')` }).where(eq(decisions.kind, "stalled_run"));
    await ctx.notes.syncDecisions();
    const links = Object.fromEntries((await ctx.db.select({ k: decisions.kind, l: notifications.link }).from(notifications).innerJoin(decisions, eq(decisions.id, notifications.decisionId))).map((r) => [r.k, r.l]));
    expect(links).toMatchObject({ stalled_run: `#/runs/${runId}`, stale_blocker: `#/tickets/${tls.id}` });
  });

  it("attaches evidence to a quiet run: last step, runner state, and what it waits on", async () => {
    ctx = await setup();
    const { runId, ticket } = await launch();
    // A turn that ended: the runner said something last, and is not mid-command (BOS-217).
    await ctx.emit({ type: "run.update", runId, update: { kind: "tool_call", title: "Run npm test", status: "completed" } } as unknown as RunnerEvent);
    ctx.advance(14 * 60_000);
    await ctx.sweep();
    const [row] = (await ctx.alerts()) as Array<Row & { evidence: Record<string, any> }>;
    expect(row!.evidence).toMatchObject({ runId, agent: "CEO", ticketId: ticket.id, ticket: "Checkout error states", runner: { connected: true }, waitingOnOwner: false });
    expect(row!.evidence.lastStep).toMatchObject({ type: "run.update", event: { update: { title: "Run npm test" } } });
    expect(new Date(row!.evidence.lastEventAt).getTime()).toBeLessThan(Date.now() + 1000);
    ctx.offline();
    const [off] = (await ctx.alerts()) as Array<Row & { evidence: Record<string, any> }>;
    expect(off!.evidence.runner.connected).toBe(false);
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
    expect((await ctx.alerts())[0]!.reasons[0]).toBe("An agent is paused until you answer");
  });

  it("closes the alert by itself, with the reason, when the run ends after it was raised (BOS-217)", async () => {
    ctx = await setup();
    const { runId } = await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    expect(await ctx.alerts()).toHaveLength(1);
    const endedAt = ctx.clock();
    await ctx.emit({ type: "run.ended", runId, stopReason: "end_turn", error: null });
    // No sweep: the event alone closes it.
    expect(await ctx.alerts()).toEqual([]);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    expect(d).toMatchObject({ status: "withdrawn", dedupeKey: null, context: { withdrawn: { by: "system", note: `the run ended normally at ${endedAt.toISOString().slice(11, 16)}` } } });
    expect((await ctx.db.select().from(activity)).some((a) => a.kind === "decision_withdrawn" && a.summary.includes('CEO has sent nothing') && a.summary.includes('ended normally'))).toBe(true);
  });

  it("closes the alert by itself when the run speaks again (BOS-217)", async () => {
    ctx = await setup();
    const { runId } = await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    expect(await ctx.alerts()).toHaveLength(1);
    // No sweep: the event alone closes it.
    await ctx.emit({ type: "run.update", runId, update: { kind: "agent_message_chunk" } } as RunnerEvent);
    expect(await ctx.alerts()).toEqual([]);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    expect(d).toMatchObject({ status: "withdrawn", context: { withdrawn: { by: "system", note: "the run is active again" } } });
  });

  it("closes the alert on the next sweep too, for a run that ended without an event", async () => {
    ctx = await setup();
    const { runId } = await launch();
    ctx.advance(6 * 60_000);
    await ctx.sweep();
    // The server ended the run itself (e.g. the runner went away): the sweep closes the alert.
    ctx.offline();
    ctx.advance(35 * 60_000);
    const res = await ctx.sweep();
    expect(res.lostRuns).toBe(1);
    expect(await ctx.alerts()).toEqual([]);
    const [d] = await ctx.db.select().from(decisions).where(eq(decisions.kind, "stalled_run"));
    expect(d).toMatchObject({ status: "withdrawn", context: { withdrawn: { by: "system" } } });
  });

  it("doesn't raise the 5-minute alert while the run waits inside a long command, then does after 15 (BOS-217)", async () => {
    ctx = await setup();
    const { runId } = await launch();
    await ctx.emit({ type: "run.update", runId, update: { kind: "tool_call", title: "pnpm check-all", status: "in_progress" } } as unknown as RunnerEvent);
    ctx.advance(10 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
    expect(await ctx.alerts()).toEqual([]);
    ctx.advance(6 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(1);
    const [row] = await ctx.alerts();
    expect(row!.question).toContain("has sent nothing for 16 minutes");
    expect(row!.question).toContain("It is still inside pnpm check-all, so it may just be a long command.");
  });

  it("doesn't alert at 15 or 60 minutes while a check script waits for the check slot, but does after 2 hours (BOS-518)", async () => {
    ctx = await setup();
    const { runId } = await launch();
    await ctx.emit({ type: "run.update", runId, update: { kind: "tool_call", title: "Run quick check", rawInput: { command: "cd /work && scripts/check-quick.sh" }, status: "in_progress" } } as unknown as RunnerEvent);
    for (const minutes of [16, 44, 30]) {
      ctx.advance(minutes * 60_000);
      await ctx.db.update(runners).set({ lastSeenAt: ctx.clock() });
      expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
    }
    expect(await ctx.alerts()).toEqual([]);
    ctx.advance(29 * 60_000);
    await ctx.db.update(runners).set({ lastSeenAt: ctx.clock() });
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
    expect(await ctx.alerts()).toEqual([]);
    ctx.advance(2 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(1);
  });

  it("still alerts after 15 minutes for a silent command that is not a check script (BOS-518)", async () => {
    ctx = await setup();
    const { runId } = await launch();
    await ctx.emit({ type: "run.update", runId, update: { kind: "tool_call", title: "Run other", rawInput: { command: "sleep 9999 # scripts/check-quick.sh.bak" }, status: "in_progress" } } as unknown as RunnerEvent);
    ctx.advance(16 * 60_000);
    expect((await ctx.sweep()).stalledRuns.raised).toBe(1);
  });

  it("doesn't raise the 5-minute alert while a connected runner is still answering pings mid-command (BOS-217)", async () => {
    ctx = await setup();
    const { runId } = await launch();
    // A turn boundary is the last event; the runner keeps saying hello while it waits on its own child process.
    await ctx.emit({ type: "run.update", runId, update: { kind: "tool_call", title: "bash", status: "pending" } } as unknown as RunnerEvent);
    ctx.advance(10 * 60_000);
    await ctx.db.update(runners).set({ lastSeenAt: ctx.clock() });
    expect((await ctx.sweep()).stalledRuns.raised).toBe(0);
    ctx.advance(6 * 60_000);
    await ctx.db.update(runners).set({ lastSeenAt: ctx.clock() });
    expect((await ctx.sweep()).stalledRuns.raised).toBe(1);
  });

  it("drops a run's open permission request from the queue when the run ends", async () => {
    ctx = await setup();
    const { runId } = await launch();
    await ctx.emit({ type: "run.permission_request", runId, requestId: "r1", title: "git push", kind: "execute", rawInput: { command: "git push origin main" }, options: [] } as unknown as RunnerEvent);
    expect(await ctx.alerts()).toHaveLength(1);
    await ctx.emit({ type: "run.ended", runId, stopReason: "cancelled", error: null });
    expect(await ctx.alerts()).toEqual([]);
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
    const [d] = await ctx.alerts();
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
    expect(await ctx.alerts()).toHaveLength(1);
    ctx.offline();
    ctx.advance(28 * 60_000);
    expect((await ctx.sweep()).lostRuns).toBe(0); // 34 minutes in: not yet 30 past the 5-minute limit
    ctx.advance(2 * 60_000);
    const res = await ctx.sweep();
    expect(res.lostRuns).toBe(1);
    expect(await row(runId)).toMatchObject({ outcome: "lost: runner offline" });
    expect((await ctx.alerts()).filter((d) => !/could not start/.test(d.question))).toEqual([]);
  });

  it("closes a run its runner restarted under, after the replay window, so it stops holding its agent (BOS-579)", async () => {
    ctx = await setup();
    const { runId } = await launched();
    const [before] = await ctx.db.select().from(runners).where(eq(runners.companyId, ctx.company.id));
    await ctx.db.update(runners).set({ bootId: "boot-1" }).where(eq(runners.id, before!.id));
    const [runner] = await ctx.db.select().from(runners).where(eq(runners.id, before!.id));
    // A reconnect of the same process changes nothing: its runs are still going.
    // (The restart time is the server's real clock, so this test moves the sweep's clock only after the restart.)
    await ctx.runners.bootSeen(runner!, "boot-1");
    expect(ctx.runners.restartedAt(runner!.id)).toBeNull();
    expect((await ctx.sweep()).lostRuns).toBe(0);

    // The runner restarts, and never reports this run (its record of live runs was lost, say).
    await ctx.runners.bootSeen(runner!, "boot-2");
    const held = await ctx.scheduler.wake({ agentId: ctx.ceo.id, reason: "engagement", note: "Engagement: the server is back." });
    await ctx.scheduler.tick();
    expect((await ctx.db.select().from(wakes).where(eq(wakes.id, held.id)))[0]!.statusReason).toBe(HELD_AGENT);
    // Inside the replay window the runner's own "interrupted" reports get their chance first.
    expect((await ctx.sweep()).lostRuns).toBe(0);
    expect((await row(runId)).endedAt).toBeNull();

    const starts = ctx.commands.filter((c) => c.type === "run.start").length;
    ctx.advance(2 * 60_000);
    expect((await ctx.sweep()).lostRuns).toBe(1);
    expect(await row(runId)).toMatchObject({ outcome: "lost: runner restarted", endedAt: expect.any(Date) });
    // The agent's one run slot is free again: the cut-off work is picked up (BOS-574), then the held wake goes next.
    await ctx.scheduler.tick();
    const next = ctx.commands.filter((c) => c.type === "run.start") as Extract<RunnerCommand, { type: "run.start" }>[];
    expect(next).toHaveLength(starts + 1);
    expect(next.at(-1)!.agentId).toBe(ctx.ceo.id);
    const [resume] = await ctx.db.select().from(wakes).where(eq(wakes.reason, "resume"));
    expect(resume).toMatchObject({ status: "launched", resumeRunId: runId });
  });

  it("leaves a run that started after the runner restarted alone (BOS-579)", async () => {
    ctx = await setup();
    const [before] = await ctx.db.select().from(runners).where(eq(runners.companyId, ctx.company.id));
    await ctx.db.update(runners).set({ bootId: "boot-1" }).where(eq(runners.id, before!.id));
    const [runner] = await ctx.db.select().from(runners).where(eq(runners.id, before!.id));
    await ctx.runners.bootSeen(runner!, "boot-2");
    ctx.advance(1_000);
    const { runId } = await launched();
    ctx.advance(3 * HOUR);
    expect((await ctx.sweep()).lostRuns).toBe(0);
    expect((await row(runId)).endedAt).toBeNull();
  });

  it("never reaps a run on a connected runner that has sent events", async () => {
    ctx = await setup();
    const { runId } = await launched();
    ctx.advance(3 * HOUR);
    expect((await ctx.sweep()).lostRuns).toBe(0);
    expect((await row(runId)).endedAt).toBeNull();
  });

  it("flags a run that has had no ticket for ten minutes to the Scrum Master, saying what woke it (BOS-254)", async () => {
    ctx = await setup();
    await ctx.db.update(agents).set({ duty: "scrum_master" }).where(eq(agents.id, ctx.worker.id));
    // A ticketless run going for eleven minutes, woken to check a stale card.
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: ctx.ceo.id, ticketId: null, origin: "checking an old card", startedAt: new Date(ctx.clock().getTime() - 11 * 60_000), lastEventAt: new Date(ctx.clock().getTime() - 30_000) });
    const res = await ctx.sweep();
    expect(res.longTicketlessRuns.raised).toBe(1);
    const [card] = await ctx.db.select().from(decisions).where(eq(decisions.status, "open"));
    expect(card!.question).toMatch(/CEO has been running for 11 minutes without a ticket .*checking an old card/);
    // One open card per run, not one per sweep.
    expect((await ctx.sweep()).longTicketlessRuns.raised).toBe(0);
  });

  it("leaves a young ticketless run and the owner chat alone", async () => {
    ctx = await setup();
    await ctx.db.update(agents).set({ duty: "scrum_master" }).where(eq(agents.id, ctx.worker.id));
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: ctx.ceo.id, ticketId: null, origin: "wiki upkeep", startedAt: new Date(ctx.clock().getTime() - 5 * 60_000) });
    await ctx.db.insert(runs).values({ companyId: ctx.company.id, agentId: ctx.worker.id, ticketId: null, purpose: "chat", origin: "owner_chat", startedAt: new Date(ctx.clock().getTime() - 30 * 60_000) });
    expect((await ctx.sweep()).longTicketlessRuns.raised).toBe(0);
  });
});

/**
 * The queue as it was before BOS-413, kept in the test as the reference the new one must match: every
 * open ticket with four joins, then every dependency row, and a chain walk that filters by done tickets.
 * Only what the fixture needs; anything else (permission runs, deploys) reads nothing here.
 */
async function legacyQueue(db: Db, now: () => Date) {
  const t = now();
  const open = await db.select({ d: decisions, companyName: companies.name, agentName: agents.name }).from(decisions).innerJoin(companies, eq(companies.id, decisions.companyId)).leftJoin(agents, eq(agents.id, decisions.raisedByAgentId)).where(and(eq(decisions.status, "open"), sql`coalesce(${decisions.context}->'ladder'->>'rung', 'owner') = 'owner'`, sql`coalesce(${decisions.context}->>'type', '') not in ('lesson', 'lesson_replace')`));
  if (!open.length) return [];
  const work = await db
    .select({ id: tickets.id, title: tickets.title, number: tickets.number, prefix: companies.ticketPrefix, dueDate: tickets.dueDate, milestoneTarget: milestones.targetDate, krPriority: objectives.priority, milestoneObjectiveId: milestones.objectiveId })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .leftJoin(keyResults, eq(keyResults.id, tickets.keyResultId))
    .leftJoin(objectives, eq(objectives.id, keyResults.objectiveId))
    .leftJoin(milestones, eq(milestones.id, tickets.milestoneId))
    .where(ne(tickets.systemState, "done"));
  const msObjectives = [...new Set(work.map((w) => w.milestoneObjectiveId).filter((x): x is string => !!x))];
  const msPriority = new Map((msObjectives.length ? await db.select({ id: objectives.id, p: objectives.priority }).from(objectives).where(inArray(objectives.id, msObjectives)) : []).map((o) => [o.id, o.p]));
  const info = new Map(
    work.map((w) => {
      const ps = [w.krPriority, w.milestoneObjectiveId ? msPriority.get(w.milestoneObjectiveId) : undefined].filter((p): p is number => p != null);
      return [w.id, { title: w.title, ref: ticketRef(w.prefix, w.number), dueDate: effectiveDueDate(w.dueDate, w.milestoneTarget), objectivePriority: ps.length ? Math.min(...ps) : null }];
    }),
  );
  // The old walk: every dependency row, by blocked ticket. Rows are read in id order both times,
  // so the order a ticket's dependents come back in (and the chain order) is the same.
  const allDeps = await db.select().from(ticketDependencies);
  const directIds = new Map(open.map(({ d }) => [d.id, allDeps.filter((x) => x.blockerDecisionId === d.id).map((x) => x.blockedTicketId)]));
  const byTicket = new Map<string, string[]>();
  for (const x of allDeps) if (x.blockerTicketId && info.has(x.blockedTicketId)) byTicket.set(x.blockerTicketId, [...(byTicket.get(x.blockerTicketId) ?? []), x.blockedTicketId]);
  const rows = open.map(({ d, companyName, agentName }) => {
    const chain: Array<BlockedTicket & { ticketId: string; title: string; ref: string | null }> = [];
    const seen = new Set<string>();
    // Same stable order as the shipped queue: nearest first, then by ticket id at each depth.
    const order = (x: string, y: string) => x.localeCompare(y);
    let frontier = (directIds.get(d.id) ?? []).filter((id) => info.has(id)).sort(order);
    for (let depth = 1; frontier.length && depth <= 10; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const i = info.get(id)!;
        chain.push({ ticketId: id, title: i.title, ref: i.ref, depth, dueDate: i.dueDate, objectivePriority: i.objectivePriority });
        next.push(...(byTicket.get(id) ?? []));
      }
      frontier = next.sort(order);
    }
    const rank = rankDecision({ createdAt: d.createdAt, blocked: chain, holdsLiveRun: d.kind === "permission" }, t);
    return { ...d, companyName, agentName, forAgentName: null, blocks: chain, about: [], refs: {}, ...rank };
  });
  // Newest first, as the shipped queue does.
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// BOS-413: the queue reads only what its open cards reach, and a feed read never writes.
describe("queue reads only what the open cards reach (BOS-413)", () => {
  /** What the queue read, by table, for one GET /api/decisions. */
  async function measureQueue() {
    ctx.reads.queries = 0;
    ctx.reads.rows = 0;
    ctx.reads.byTable = {};
    ctx.reads.on = true;
    const q = (await ctx.req("GET", "/api/decisions")).json() as Row[];
    ctx.reads.on = false;
    return { q, queries: ctx.reads.queries, byTable: ctx.reads.byTable };
  }

  it("does not read dependency rows, or tickets below a finished ticket, that no card reaches", async () => {
    ctx = await setup();
    const chain = async () => {
      const a = await ctx.ticket({ title: "A" });
      const b = await ctx.ticket({ title: "B", state: "blocked" });
      const c = await ctx.ticket({ title: "C", state: "blocked" });
      await ctx.req("POST", `/api/tickets/${b.id}/dependencies`, { ticketId: a.id });
      await ctx.req("POST", `/api/tickets/${c.id}/dependencies`, { ticketId: b.id });
      return { a, b, c };
    };
    const live = await chain();
    const held = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Ship it?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: live.a.id });
    // A chain below a finished ticket, and loose live work no card points at.
    const done = await chain();
    await ctx.req("PATCH", `/api/tickets/${done.a.id}`, { state: "done" });
    const loose = await chain();
    ctx.advance(HOUR);
    await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Team name?", options: ["A", "B"], recommended: "A" });

    const { q, byTable } = await measureQueue();
    // Same output as before, still down the chain from what the card holds.
    expect(q.find((r) => r.id === held.id)!.blocks).toEqual([
      expect.objectContaining({ ticketId: live.a.id, depth: 1 }),
      expect.objectContaining({ ticketId: live.b.id, depth: 2 }),
      expect.objectContaining({ ticketId: live.c.id, depth: 3 }),
    ]);
    // Only the rows that name an open card, then the chain's own edges: the done chain below `done.a`
    // and the loose chain are never read.
    const deps = await ctx.db.select().from(ticketDependencies);
    expect(byTable["ticket_dependencies"] ?? 0).toBeLessThan(deps.length);
    expect(q.every((r) => r.blocks.every((b) => b.ticketId !== done.b.id && b.ticketId !== done.c.id))).toBe(true);
    expect(q.some((r) => r.blocks.some((b) => b.ticketId === loose.a.id || b.ticketId === loose.b.id || b.ticketId === loose.c.id))).toBe(false);
  });

  it("marks a card's notification read when it is answered, without the feed read writing", async () => {
    ctx = await setup();
    const d = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Ship the beta?", options: ["Yes", "No"], recommended: "Yes" });
    const other = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Rename the app?", options: ["Yes", "No"], recommended: "No" });
    await ctx.notes.syncDecisions();
    expect((await ctx.req("GET", "/api/notifications")).json().unread).toBe(2);

    // Answering marks that card read at once: the feed is right before any sweep runs.
    expect((await ctx.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Yes" })).statusCode).toBe(200);
    const [note] = await ctx.db.select().from(notifications).where(eq(notifications.decisionId, d.id));
    expect(note!.readAt).not.toBeNull();
    expect((await ctx.req("GET", "/api/notifications")).json().unread).toBe(1);

    // A close made elsewhere still shows once it settles, but a read never writes: it takes the sweep.
    await ctx.db.update(decisions).set({ status: "withdrawn" }).where(eq(decisions.id, other.id));
    expect((await ctx.req("GET", "/api/notifications")).json().unread).toBe(1);
    await ctx.notes.markAnsweredRead();
    expect((await ctx.req("GET", "/api/notifications")).json().unread).toBe(0);
  });

  it("leaves a done ticket out of the chain even when the card holds it directly and it still has live dependents", async () => {
    ctx = await setup();
    // A ticket with a live dependent, held directly by a card that is then answered out of band: the
    // ticket is finished while the card is still open, so it is done and still holds live work.
    const finished = await ctx.ticket({ title: "Finished" });
    const live = await ctx.ticket({ title: "Still waiting", state: "blocked" });
    await ctx.req("POST", `/api/tickets/${live.id}/dependencies`, { ticketId: finished.id });
    const card = await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Ship it?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: finished.id });
    // Finished behind the card's back, as another path (a merge, another ticket) would.
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, finished.id));

    const mine = (await ctx.queue()) as unknown as Array<Record<string, unknown> & { id: string; createdAt: string }>;
    const row = mine.find((r) => r.id === card.id)!;
    // The done ticket is not the start of a chain, so neither it nor its dependents appear.
    expect(row.blocks).toEqual([]);

    // The done ticket is still named as what the card is about, as before; only the chain leaves it out.
    expect(row.about).toEqual([expect.objectContaining({ ticketId: finished.id, title: "Finished" })]);
    // Same chain as the old whole-table walk.
    const legacyRaw = await legacyQueue(ctx.db, () => new Date());
    const old = legacyRaw.map((r) => ({ ...r, about: row.about, refs: {}, createdAt: r.createdAt.toISOString() }));
    expect(mine).toEqual(old);
  });

  it("returns the same queue as the old whole-table walk on a fixture with chained dependencies", async () => {
    ctx = await setup();
    const chain = async (prefix: string, length: number) => {
      const out: Array<{ id: string }> = [];
      for (let i = 0; i < length; i++) out.push(await ctx.ticket({ title: `${prefix} ${i}`, ...(i ? { state: "blocked" } : {}) }));
      for (let i = 1; i < length; i++) await ctx.req("POST", `/api/tickets/${out[i]!.id}/dependencies`, { ticketId: out[i - 1]!.id });
      return out;
    };
    const root = await chain("Root", 4);
    const branch = await chain("Branch", 2);
    await ctx.req("POST", `/api/tickets/${branch[1]!.id}/dependencies`, { ticketId: root[2]!.id });
    // A finished ticket mid-chain: both walks stop there.
    const doneMid = await chain("Finished", 2);
    await ctx.req("PATCH", `/api/tickets/${doneMid[0]!.id}`, { state: "done" });
    await chain("Loose", 3);
    const heldCards = [
      await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Ship the chain?", options: ["Yes", "No"], recommended: "Yes", blocksTicketId: root[0]!.id }),
      await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Start the branch?", options: ["Yes", "No"], recommended: "No", blocksTicketId: branch[0]!.id }),
      await ctx.decisions.raise({ companyId: ctx.company.id, agentId: ctx.ceo.id, question: "Unrelated?", options: ["A", "B"], recommended: "A" }),
    ];
    // The shipped queue and the old body (every open ticket, then every dependency row) must agree
    // field for field, right down to the score and its reasons. What it adds beyond the old body is
    // the tickets a card is about and the card's references; those are filled in here for comparison.
    const mine = (await ctx.queue()) as unknown as Array<Record<string, unknown> & { id: string; createdAt: string }>;
    const legacyRaw = await legacyQueue(ctx.db, () => new Date());
    const about = (id: string) => [{ ticketId: id, title: id === root[0]!.id ? "Root 0" : "Branch 0", ref: id === root[0]!.id ? "APP-1" : "APP-5" }];
    const old = legacyRaw.map((r) => ({
      ...r,
      about: r.id === heldCards[0]!.id ? about(root[0]!.id) : r.id === heldCards[1]!.id ? about(branch[0]!.id) : [],
      // A Date in the old body, an ISO string over HTTP.
      createdAt: r.createdAt.toISOString(),
    }));
    expect(mine).toEqual(old);
    expect(mine.map((r) => r.id)).toEqual(expect.arrayContaining(heldCards.map((c) => c.id)));
  });
});
