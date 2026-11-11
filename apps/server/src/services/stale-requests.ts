// Stale "waiting on you" requests (BOS-123): when the owner acts, open cards and state
// notes about the same ticket (or anything waiting on it) are marked possibly out of date,
// and the agent that wrote them is woken once to confirm or withdraw. A request the owner
// has already answered is refused, quoting the earlier answer.
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, decisions, deploys, runs, ticketDependencies, ticketMessages, tickets } from "../db/schema.js";
import { closeInvalidCards, RECHECK_AUTHOR_MS, RECHECK_CEO_MS } from "./card-validity.js";

type DecisionRow = typeof decisions.$inferSelect;

/** Why a stale-request wake starts a run (BOS-254): plain words, not "stale request". */
export const STALE_REASON = "checking an old card";

/** Wakes an agent; the scheduler's notify matches this shape. */
export type WakeFn = (input: { agentId: string; reason: string; note: string; ticketId?: string | null; priority?: number }) => Promise<unknown>;

/** What an author does when woken about a card that is being re-checked (BOS-1193): each way takes one tool call. */
const RECHECK_STEPS = [
  "The card is hidden from the owner's main list while you re-check it. You have 30 minutes, then it goes to the CEO.",
  "Check the live state first: their latest answers, what's deployed, and whether the tickets involved are done. Then do exactly one:",
  "- It still holds: withdraw_decision with action confirm and checked (one line on what you checked). Nothing is written on the card.",
  "- It needs changing: raise one corrected card with raise_decision replaces <this card's id>; the old one closes as superseded.",
  "- It is no longer needed: withdraw_decision (action withdraw, with a reason).",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tickets a decision is about: what it holds up, plus a ticket named in its context. */
export async function decisionTicketIds(db: Db, d: Pick<DecisionRow, "id" | "context">): Promise<string[]> {
  const c = d.context as { type?: string; ticketId?: unknown; runId?: string; deployId?: string; blockedTicketId?: string; engagementId?: string };
  const own = typeof c.ticketId === "string" ? [c.ticketId] : [];
  switch (c.type) {
    case "permission":
    case "stalled_run": {
      const [r] = c.runId && UUID.test(c.runId) ? await db.select({ ticketId: runs.ticketId }).from(runs).where(eq(runs.id, c.runId)) : [];
      return [...new Set([...own, ...(r?.ticketId ? [r.ticketId] : [])])];
    }
    case "deploy": {
      const [r] = c.deployId && UUID.test(c.deployId) ? await db.select({ ticketId: deploys.ticketId }).from(deploys).where(eq(deploys.id, c.deployId)) : [];
      return r?.ticketId ? [r.ticketId] : own;
    }
    case "stale_blocker":
      return [...new Set([...(c.blockedTicketId ? [c.blockedTicketId] : []), ...own])];
    case "engagement": {
      const rows = c.engagementId
        ? await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerEngagementId, c.engagementId))
        : [];
      return [...new Set([...rows.map((r) => r.id), ...own])];
    }
    default: {
      const rows = await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id));
      return [...new Set([...rows.map((r) => r.id), ...own])];
    }
  }
}

/** Every ticket that (transitively) waits on this one, nearest first. */
export async function dependentsOf(db: Db, ticketId: string): Promise<string[]> {
  // not state: built per call and thrown away.
  const seen = new Set<string>();
  let frontier = [ticketId];
  for (let depth = 0; frontier.length && depth < 10; depth++) {
    const rows = await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(inArray(ticketDependencies.blockerTicketId, frontier));
    const next = rows.map((r) => r.id).filter((id) => !seen.has(id));
    for (const id of next) seen.add(id);
    frontier = next;
  }
  return [...seen];
}

/** A card confirmed this many times and flagged again within a day goes straight to the CEO (DR-054 point 5). */
export const RECHECK_NOISY_COUNT = 2;
const DAY_MS = 86_400_000;

type FlaggedCard = { id: string; raisedByAgentId: string | null; recheckedAt?: Date | null; recheckCount?: number };

/**
 * BOS-1193 (DR-054): puts these cards into "being re-checked". Boss Man checks first: a card the validity table can
 * close is closed here and never flagged, so its author isn't woken for nothing. The rest go to their author with 30
 * minutes to settle them. A card with no author, a paused or deleted author, the CEO as author, or one confirmed twice
 * in the last day goes straight to the CEO's stage. Returns the cards now in re-check, and which of them are at the CEO.
 */
async function enterRecheck(db: Db, input: { cards: FlaggedCard[]; reason: string; now: Date }): Promise<{ rechecking: FlaggedCard[]; atCeo: Set<string> }> {
  if (!input.cards.length) return { rechecking: [], atCeo: new Set() };
  await closeInvalidCards(db, { now: () => input.now }, { ids: input.cards.map((c) => c.id) });
  const still = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(inArray(decisions.id, input.cards.map((c) => c.id)), eq(decisions.status, "open"), isNull(decisions.staleAt)));
  const live = new Set(still.map((s) => s.id));
  const rechecking = input.cards.filter((c) => live.has(c.id));
  if (!rechecking.length) return { rechecking: [], atCeo: new Set() };
  const authorIds = [...new Set(rechecking.map((c) => c.raisedByAgentId).filter((a): a is string => !!a))];
  const authors = authorIds.length ? await db.select({ id: agents.id, role: agents.role, paused: agents.paused }).from(agents).where(inArray(agents.id, authorIds)) : [];
  const reachable = new Set(authors.filter((a) => !a.paused && a.role !== "ceo").map((a) => a.id));
  const atCeo = new Set(
    rechecking
      .filter((c) => !c.raisedByAgentId || !reachable.has(c.raisedByAgentId) || ((c.recheckCount ?? 0) >= RECHECK_NOISY_COUNT && !!c.recheckedAt && input.now.getTime() - c.recheckedAt.getTime() < DAY_MS))
      .map((c) => c.id),
  );
  const toCeo = [...atCeo];
  const toAuthor = rechecking.filter((c) => !atCeo.has(c.id)).map((c) => c.id);
  const base = { staleAt: input.now, staleReason: input.reason, recheckStageAt: input.now };
  if (toAuthor.length) await db.update(decisions).set({ ...base, recheckStage: "author" }).where(and(inArray(decisions.id, toAuthor), eq(decisions.status, "open"), isNull(decisions.staleAt)));
  if (toCeo.length) await db.update(decisions).set({ ...base, recheckStage: "ceo" }).where(and(inArray(decisions.id, toCeo), eq(decisions.status, "open"), isNull(decisions.staleAt)));
  return { rechecking, atCeo };
}

/** The author could not be woken (the wake was dropped): their cards go to the CEO now rather than after 30 minutes. */
async function moveToCeo(db: Db, ids: string[], now: Date) {
  if (ids.length) await db.update(decisions).set({ recheckStage: "ceo", recheckStageAt: now }).where(and(inArray(decisions.id, ids), eq(decisions.status, "open"), eq(decisions.recheckStage, "author")));
}

/**
 * Wakes the CEO once with every card now at their stage in a company (one list, not one wake per card), and
 * says what to do with each. Returns true when the CEO was woken.
 */
export async function wakeCeoForRecheck(db: Db, input: { companyId: string; wake?: WakeFn | null; ids: string[] }): Promise<boolean> {
  if (!input.wake || !input.ids.length) return false;
  const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.role, "ceo")));
  if (!ceo) return false;
  const cards = await db.select({ id: decisions.id, question: decisions.question, reason: decisions.staleReason, by: agents.name }).from(decisions).leftJoin(agents, eq(agents.id, decisions.raisedByAgentId)).where(and(inArray(decisions.id, input.ids), eq(decisions.status, "open"), eq(decisions.recheckStage, "ceo")));
  if (!cards.length) return false;
  const w = await input.wake({
    agentId: ceo.id,
    ticketId: null,
    reason: STALE_REASON,
    note: [
      `${cards.length === 1 ? "A card is" : `${cards.length} cards are`} being re-checked and its author did not settle ${cards.length === 1 ? "it" : "them"} in time. You have 30 minutes; after that ${cards.length === 1 ? "it goes" : "they go"} back to the owner marked as not re-checked by you.`,
      ...cards.map((c) => `- ${c.id}: "${c.question.slice(0, 160)}" (raised by ${c.by ?? "Boss Man"}; flagged because ${c.reason ?? "something it depends on changed"})`),
      "Check each against the live state. Use the decisions tool: action recheck with the card's id and note (one line on what you checked) to confirm it still holds, or action withdraw with a reason, or raise one corrected card with raise_decision replaces <id>.",
    ].join("\n"),
  });
  return !(!w || (typeof w === "object" && "status" in w && (w as { status?: string }).status === "dropped"));
}

type ActedResult ={ flaggedDecisions: string[]; flaggedTickets: string[]; woken: string[] };

/**
 * The owner did something on these tickets: mark open cards about them (and everything that
 * waits on them) "may be out of date", mark their state notes stale, and wake each author
 * once to confirm or withdraw. Anything already flagged is left alone, so one action is one wake.
 */
export async function ownerActed(db: Db, input: { companyId: string; ticketIds: string[]; reason: string; wake?: WakeFn | null; now?: Date; /** Agents already being woken for this action, so they get one note, not two. */ skipAgents?: Array<string | null> }): Promise<ActedResult> {
  const now = input.now ?? new Date();
  const roots = [...new Set(input.ticketIds.filter((id): id is string => !!id))];
  if (!roots.length) return { flaggedDecisions: [], flaggedTickets: [], woken: [] };
  const dependents = (await Promise.all(roots.map((id) => dependentsOf(db, id)))).flat();
  const scope = [...new Set([...roots, ...dependents])];

  // A finished ticket's own note no longer matters; the ones that wait on it do.
  const noted = await db
    .select({ id: tickets.id, assigneeAgentId: tickets.assigneeAgentId, state: tickets.systemState })
    .from(tickets)
    .where(and(eq(tickets.companyId, input.companyId), inArray(tickets.id, scope), isNull(tickets.stateNoteStaleAt), sql`${tickets.stateNote} is not null`, ne(tickets.systemState, "done")));
  const flaggedTickets = noted.map((n) => n.id);
  if (flaggedTickets.length) await db.update(tickets).set({ stateNoteStaleAt: now }).where(inArray(tickets.id, flaggedTickets));

  // A card's tickets are the ones its context names (ticketId, blockedTicketId) or blocks, plus for
  // a permission or stall card the ticket of the run it names and for a deploy the ticket it
  // deploys. All of that is resolved in SQL, so an owner action doesn't run a query per open card
  // in the company (BOS-175); the per-card lookup below then confirms the matches. Compared as
  // text, so a context value that isn't an id simply doesn't match rather than failing to cast.
  const named = sql`${inArray(sql`(${decisions.context} ->> 'ticketId')`, scope)} or ${inArray(sql`(${decisions.context} ->> 'blockedTicketId')`, scope)}`;
  const blocking = sql`exists (select 1 from ${ticketDependencies} where ${ticketDependencies.blockerDecisionId} = ${decisions.id} and ${inArray(ticketDependencies.blockedTicketId, scope)})`;
  const deployTicket = sql`exists (select 1 from ${deploys} where ${deploys.id}::text = (${decisions.context} ->> 'deployId') and ${inArray(deploys.ticketId, scope)})`;
  // An engagement card names no ticket or card id, only an engagement; its tickets are the ones blocked
  // by that engagement. Found in SQL too, or an owner action would stop marking it (BOS-175).
  const engagementCard = sql`exists (select 1 from ${ticketDependencies} where ${ticketDependencies.blockerEngagementId}::text = (${decisions.context} ->> 'engagementId') and ${inArray(ticketDependencies.blockedTicketId, scope)})`;
  // Only cards a person wrote: a card Boss Man raised itself (no raiser, or one that went up the
  // alert ladder) is not made "may be out of date" by an answer. That guess is how Jane's answer on
  // one card was quoted on Rod's stalled-run card for the same ticket (BOS-470); a system card is
  // either current or closed by its own condition, not marked stale. A question an agent asked by
  // hand keeps today's flag-and-wake, and is matched only by the ticket it names or blocks, never by
  // an answer on a different card about the same ticket.
  const system = or(isNull(decisions.raisedByAgentId), sql`${decisions.context}->'ladder' is not null`);
  const open = await db
    .select({ id: decisions.id, raisedByAgentId: decisions.raisedByAgentId, context: decisions.context, recheckedAt: decisions.recheckedAt, recheckCount: decisions.recheckCount })
    .from(decisions)
    .where(and(eq(decisions.companyId, input.companyId), eq(decisions.status, "open"), isNull(decisions.staleAt), sql`not (${system})`, or(named, blocking, deployTicket, engagementCard)));
  // The query above already picked out the cards about these tickets (BOS-175). Boss Man checks them before any
  // author is asked (BOS-1193): a card it can see is dead closes, the rest go into "being re-checked".
  const { rechecking: flagged, atCeo } = await enterRecheck(db, { cards: open, reason: input.reason, now });
  const flaggedDecisions = flagged.map((d) => d.id);

  // One wake per agent, naming what changed and what to do about it. Only an agent that actually
  // holds a card or a state note the answer could have made out of date is woken (BOS-254): a
  // ticket that merely waits on one in scope is flagged for its own note, but its assignee is not
  // woken just for the wait, and a ticket with no note has nobody to wake.
  const skip = new Set(input.skipAgents?.filter((id): id is string => !!id) ?? []);
  // not state: built per call and thrown away.
  const targets = new Map<string, { ticketId: string | null }>();
  for (const d of flagged) if (d.raisedByAgentId && !atCeo.has(d.id) && !skip.has(d.raisedByAgentId) && !targets.has(d.raisedByAgentId)) targets.set(d.raisedByAgentId, { ticketId: null });
  // Woken only for a note or card of their own: `noted` is every flagged note (a dependent's own
  // "waiting on it" note counts, it is really out of date), and `flagged` is every open card about
  // anything in scope. Nobody is woken just for a ticket being listed downstream.
  for (const n of noted) if (n.assigneeAgentId && !skip.has(n.assigneeAgentId) && !targets.has(n.assigneeAgentId)) targets.set(n.assigneeAgentId, { ticketId: n.id });
  const woken: string[] = [];
  if (input.wake) {
    for (const [agentId, target] of targets) {
      const w = await input.wake({
        agentId,
        ticketId: target.ticketId,
        reason: STALE_REASON,
        note: [
          `The owner acted (${input.reason}), so a decision card or the state note you left may now be out of date.`,
          ...RECHECK_STEPS,
          "Also update the ticket's state note in this run if it is affected. If nothing of yours is affected, end the run.",
        ].join("\n"),
      });
      if (!w || (typeof w === "object" && "status" in w && (w as { status?: string }).status === "dropped")) {
        // Nobody to ask: the CEO has it now, not in 30 minutes.
        const theirs = flagged.filter((d) => d.raisedByAgentId === agentId && !atCeo.has(d.id)).map((d) => d.id);
        await moveToCeo(db, theirs, now);
        for (const id of theirs) atCeo.add(id);
        continue;
      }
      woken.push(agentId);
    }
  }
  if (input.wake && atCeo.size) await wakeCeoForRecheck(db, { companyId: input.companyId, wake: input.wake, ids: [...atCeo] });
  return { flaggedDecisions, flaggedTickets, woken };
}

/**
 * Flags these open cards "may be out of date" and wakes each author once (BOS-1161). Never closes a card: only a
 * checkable `clearWhen` condition does that (alert-clearing.ts). A card already flagged is left alone, so one event is one wake.
 */
async function flagCards(db: Db, input: { cards: FlaggedCard[]; reason: string; wake?: WakeFn | null; now: Date; companyId?: string }): Promise<{ flaggedDecisions: string[]; woken: string[] }> {
  const { rechecking, atCeo } = await enterRecheck(db, { cards: input.cards, reason: input.reason, now: input.now });
  const woken: string[] = [];
  if (input.wake) {
    for (const agentId of new Set(rechecking.filter((c) => !atCeo.has(c.id)).map((c) => c.raisedByAgentId).filter((a): a is string => !!a))) {
      const w = await input.wake({
        agentId,
        ticketId: null,
        reason: STALE_REASON,
        note: [`${input.reason}, so a decision card you raised may now be out of date.`, ...RECHECK_STEPS, "Also update the ticket's state note in this run if it is affected."].join("\n"),
      });
      if (!w || (typeof w === "object" && "status" in w && (w as { status?: string }).status === "dropped")) {
        const theirs = rechecking.filter((c) => c.raisedByAgentId === agentId).map((c) => c.id);
        await moveToCeo(db, theirs, input.now);
        for (const id of theirs) atCeo.add(id);
        continue;
      }
      woken.push(agentId);
    }
    if (atCeo.size && input.companyId) await wakeCeoForRecheck(db, { companyId: input.companyId, wake: input.wake, ids: [...atCeo] });
  }
  return { flaggedDecisions: rechecking.map((c) => c.id), woken };
}

/** The open cards a person (an agent) wrote and nobody has flagged yet: Boss Man's own cards close by their own condition instead (BOS-470). */
const agentCardFilter = (companyId: string) =>
  and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), isNull(decisions.staleAt), sql`${decisions.raisedByAgentId} is not null`, sql`${decisions.context}->'ladder' is null`);

/**
 * The runners were rebuilt (BOS-1161): open question cards that talk about the runners or a rebuild may be moot now.
 * Matched on the card's own words, because a card about the runner names no ticket; it is flagged and its author
 * woken to confirm or withdraw, never closed (a card that named a rebuild in `clearsWhen` was closed already).
 */
export async function runnerRebuilt(db: Db, input: { companyId: string; wake?: WakeFn | null; now?: Date }) {
  const open = await db
    .select({ id: decisions.id, raisedByAgentId: decisions.raisedByAgentId, recheckedAt: decisions.recheckedAt, recheckCount: decisions.recheckCount })
    .from(decisions)
    .where(and(agentCardFilter(input.companyId), sql`(${decisions.question} ~* 'runner|rebuild')`));
  return flagCards(db, { cards: open, reason: "the runners were rebuilt", wake: input.wake, now: input.now ?? new Date(), companyId: input.companyId });
}

/**
 * A card's own ticket changed state well after the card was raised (BOS-1161): the work went on without the answer, or
 * someone moved it. Compared to the card's age plus a grace period, because raising a card that blocks its ticket moves
 * the ticket too. Run from the sweep, since ticket state moves from many places (a database trigger stamps each one).
 */
export const STATE_CHANGE_GRACE_MS = 2 * 60_000;
export async function ticketStateChanged(db: Db, input: { companyId?: string; wake?: WakeFn | null; now?: Date }) {
  const now = input.now ?? new Date();
  const open = await db
    .select({ id: decisions.id, raisedByAgentId: decisions.raisedByAgentId, companyId: decisions.companyId, recheckedAt: decisions.recheckedAt, recheckCount: decisions.recheckCount })
    .from(decisions)
    .innerJoin(tickets, sql`${tickets.id}::text = (${decisions.context} ->> 'ticketId')`)
    // A card a re-check confirmed is only flagged by a change after that confirmation (BOS-1193): else the same old
    // state change would flag it again on every sweep. `greatest` ignores a null recheckedAt.
    .where(and(eq(decisions.status, "open"), isNull(decisions.staleAt), sql`${decisions.raisedByAgentId} is not null`, sql`${decisions.context}->'ladder' is null`, sql`(${decisions.kind} <> 'permission' or ${decisions.context}->>'plan' = 'true')`, sql`${tickets.stateChangedAt} > greatest(${decisions.createdAt} + (${STATE_CHANGE_GRACE_MS} * interval '1 millisecond'), ${decisions.recheckedAt})`, ...(input.companyId ? [eq(decisions.companyId, input.companyId)] : [])));
  const out = { flaggedDecisions: [] as string[], woken: [] as string[] };
  for (const companyId of new Set(open.map((d) => d.companyId))) {
    const r = await flagCards(db, { cards: open.filter((d) => d.companyId === companyId), reason: "the ticket it is about changed state", wake: input.wake, now, companyId });
    out.flaggedDecisions.push(...r.flaggedDecisions);
    out.woken.push(...r.woken);
  }
  return out;
}

/**
 * The re-check clock (BOS-1193, DR-054), run from the sweep: a card its author did not settle in 30 minutes goes to the
 * CEO (one wake per company listing every such card), and a card the CEO did not settle in a further 30 goes back to the
 * owner as "lapsed", which says plainly who failed to re-check it. A lapsed card is not re-checked again.
 */
export async function recheckDeadlines(db: Db, input: { wake?: WakeFn | null; now?: Date }) {
  const now = input.now ?? new Date();
  const lapsed = await db
    .update(decisions)
    .set({ recheckStage: "lapsed", recheckStageAt: now })
    .where(and(eq(decisions.status, "open"), eq(decisions.recheckStage, "ceo"), sql`${decisions.recheckStageAt} <= ${new Date(now.getTime() - RECHECK_CEO_MS)}`))
    .returning({ id: decisions.id });
  const toCeo = await db
    .update(decisions)
    .set({ recheckStage: "ceo", recheckStageAt: now })
    .where(and(eq(decisions.status, "open"), eq(decisions.recheckStage, "author"), sql`${decisions.recheckStageAt} <= ${new Date(now.getTime() - RECHECK_AUTHOR_MS)}`))
    .returning({ id: decisions.id, companyId: decisions.companyId });
  for (const companyId of new Set(toCeo.map((c) => c.companyId))) {
    await wakeCeoForRecheck(db, { companyId, wake: input.wake, ids: toCeo.filter((c) => c.companyId === companyId).map((c) => c.id) });
  }
  return { lapsed: lapsed.map((l) => l.id), movedToCeo: toCeo.map((c) => c.id) };
}

export type OwnerAnswer ={ kind: "decision" | "message"; question: string | null; answer: string; at: Date };

const askWords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

/** True when two asks are close enough to be the same one repeated (BOS-123). */
export function similarQuestion(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (norm(a) === norm(b)) return true;
  const x = askWords(a);
  const y = askWords(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

/**
 * The latest thing the owner said or answered on these tickets recently, for the duplicate check.
 * Pass decisionTypes to count only the kinds that answer this sort of ask; pass question to count
 * only an ask close enough to be the same one, so a different question never blocks a fresh ask
 * (BOS-123, BOS-175). Pass decisionId to ask about one card rather than the tickets.
 */
export async function recentOwnerAnswer(db: Db, input: {
  companyId: string;
  ticketIds: string[];
  since?: Date;
  /** Count what the owner wrote on the ticket as well as answered decisions; off for the duplicate-ask check and when one card is named. */
  includeMessages?: boolean;
  /** Decision context types that count; default every kind. */
  decisionTypes?: string[];
  /**
   * Count only this card being settled (BOS-175), not any answer about these tickets: a reminder
   * or a refusal asks about one card, and another card's answer or a plain message doesn't settle it.
   */
  decisionId?: string | null;
  /** Only a decision whose question closely matches `question` counts, whoever asked it (BOS-175). */
  question?: string;
}): Promise<OwnerAnswer | null> {
  const ids = [...new Set(input.ticketIds.filter((id): id is string => !!id))];
  const since = input.since ?? new Date(Date.now() - 7 * 86_400_000);
  const found: OwnerAnswer[] = [];

  // The ticket ids this card holds up are already known, so the check is one row read, no extra query.
  const one = async (id: string | null) => {
    if (!id) return null;
    const [d] = await db
      .select({ context: decisions.context, question: decisions.question, answer: decisions.answer, answeredAt: decisions.answeredAt })
      .from(decisions)
      .where(and(eq(decisions.id, id), eq(decisions.companyId, input.companyId), eq(decisions.status, "answered"), gt(decisions.answeredAt, since)))
      .limit(1);
    return d ?? null;
  };

  if (input.decisionId) {
    const d = await one(input.decisionId);
    if (!d?.answer || !d.answeredAt) return null;
    const type = (d.context as { type?: string } | null)?.type;
    if (input.decisionTypes && !input.decisionTypes.includes(type ?? "")) return null;
    if (input.question !== undefined && !similarQuestion(input.question, d.question)) return null;
    found.push({ kind: "decision", question: d.question, answer: d.answer, at: d.answeredAt });
  } else if (ids.length) {
    // A card is about a ticket when its context names it by id, or when it blocks one. Both filters
    // run in SQL, so an owner action doesn't run one query per answered card (BOS-175). Compared as
    // text, so a context value that isn't an id simply doesn't match rather than failing to cast.
    const named = inArray(sql`(${decisions.context} ->> 'ticketId')`, ids);
    const blocking = sql`exists (select 1 from ${ticketDependencies} where ${ticketDependencies.blockerDecisionId} = ${decisions.id} and ${inArray(ticketDependencies.blockedTicketId, ids)})`;
    const answered = await db
      .select({ id: decisions.id, context: decisions.context, question: decisions.question, answer: decisions.answer, answeredAt: decisions.answeredAt })
      .from(decisions)
      .where(and(eq(decisions.companyId, input.companyId), eq(decisions.status, "answered"), gt(decisions.answeredAt, since), or(named, blocking)))
      .orderBy(desc(decisions.answeredAt));
    for (const d of answered) {
      if (!d.answer || !d.answeredAt) continue;
      const type = (d.context as { type?: string } | null)?.type;
      if (input.decisionTypes && !input.decisionTypes.includes(type ?? "")) continue;
      // Similarity always applies, even to the same agent's ask (BOS-175): an answered question
      // doesn't make every later, unrelated question from that agent a repeat.
      if (input.question !== undefined && !similarQuestion(input.question, d.question)) continue;
      found.push({ kind: "decision", question: d.question, answer: d.answer, at: d.answeredAt });
    }
  }

  if (input.includeMessages !== false && !input.decisionId && ids.length) {
    const said = await db
      .select({ text: ticketMessages.text, at: ticketMessages.createdAt })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.companyId, input.companyId), eq(ticketMessages.author, "owner"), inArray(ticketMessages.ticketId, ids), gt(ticketMessages.createdAt, since)))
      .orderBy(desc(ticketMessages.createdAt));
    for (const m of said) found.push({ kind: "message", question: null, answer: m.text, at: m.at });
  }

  return found.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
}

/** A short quoted reading of an earlier owner answer, for a refusal or a card. */
export function quotedAnswer(a: OwnerAnswer, at = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ")): string {
  const what = a.kind === "decision" && a.question ? `your question "${a.question}"` : "this ticket";
  return `The owner already answered ${what} on ${at(a.at)} UTC: "${a.answer}"`;
}
