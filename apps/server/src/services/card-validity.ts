// One ordered validity table for the cards agents raise (BOS-1193, DR-054). A card the owner sees has been
// checked: when Boss Man can see from live rows that a card is dead, it closes it by itself, with the reason
// in the card's history, instead of flagging it and leaving the owner to work it out. The first row that
// matches wins:
//   0. an owner-only question card (BOS-1755): never closed by this table; it stays open, labelled once its ticket
//      is finished, merged or cancelled. The ticket itself can't finish while the card is open (openHoldingCard).
//   1. its ticket is done or cancelled          4. a plan card, and the plan was approved on another card
//   2. its ticket is merged                     5. a plan card, and a newer plan card replaces it
//   3. a plan card, and the ticket is in review (clearsWhen, row 6, stays in alert-clearing.ts)
// Closing never counts as an answer, never touches an approval already given (BOS-371, `planApprovedAt` is only
// read), and is conditional on the card still being open, so an owner answer that races it leaves one outcome.
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions, engagements, runs, ticketDependencies, tickets } from "../db/schema.js";
import { systemMoveTicket } from "./ticket-transition.js";
import { openBlockers } from "./ticket-links.js";
import { mergeContext } from "./decision-context.js";
import { record } from "./activity.js";
import { revokeApproveTokens } from "./approve-tokens.js";
/** How long the author, then the CEO, has to settle a card that is being re-checked. */
export const RECHECK_AUTHOR_MS = 30 * 60_000;
export const RECHECK_CEO_MS = 30 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cards this table judges: an agent's own question or plan, never a card Boss Man raised itself (the ladder) or a sign-off. */
export const checkableCard = sql`(${decisions.raisedByAgentId} is not null and ${decisions.context}->'ladder' is null and (${decisions.context}->>'type' in ('question', 'engagement') or (${decisions.context}->>'type' = 'permission' and ${decisions.context}->>'plan' = 'true')))`;

type CardRow = { id: string; companyId: string; createdAt: Date; question: string; context: unknown };

type Ctx = { type?: string; ownerOnly?: unknown; ownerMustDo?: unknown; keptOpen?: unknown; plan?: boolean; ticketId?: string; runId?: string; criterionIndexes?: unknown; steps?: unknown; setsUp?: unknown; engagementId?: string; ladder?: { ticketId?: string | null } };

/** The same cards as `checkableCard`, for a row already in hand (answering and phone approve). */
export function isCheckableCard(d: { raisedByAgentId: string | null; context: unknown }): boolean {
  const c = d.context as Ctx;
  if (!d.raisedByAgentId || c.ladder) return false;
  return c.type === "question" || c.type === "engagement" || (c.type === "permission" && c.plan === true);
}

/** True when this plan or permission card's run is still alive: that run is waiting on the answer, so only its own end closes the card. */
export async function holdsLiveRun(db: Db, context: unknown): Promise<boolean> {
  const c = context as Ctx;
  if (c.type !== "permission" || typeof c.runId !== "string" || !UUID_RE.test(c.runId)) return false;
  const [run] = await db.select({ endedAt: runs.endedAt }).from(runs).where(eq(runs.id, c.runId));
  return !!run && !run.endedAt;
}

/** A question card marked as the owner's alone (ownerOnly kind or ownerMustDo), BOS-1755. */
export function isOwnerOnly(c: { type?: string; ownerOnly?: unknown; ownerMustDo?: unknown }): boolean {
  return c.type === "question" && (!!c.ownerOnly || c.ownerMustDo === true);
}

/** The tickets a card is about: the one it names, else the ones it holds up. */
async function cardTickets(db: Db, d: CardRow) {
  const named = (d.context as Ctx).ticketId ?? (d.context as Ctx).ladder?.ticketId;
  const ids = typeof named === "string" && UUID_RE.test(named)
    ? [named]
    : (await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id))).map((r) => r.id);
  if (!ids.length) return [];
  return db.select({ id: tickets.id, title: tickets.title, state: tickets.systemState, outcome: tickets.outcome, mergeCommit: tickets.mergeCommit, planApprovedAt: tickets.planApprovedAt }).from(tickets).where(and(inArray(tickets.id, ids), eq(tickets.companyId, d.companyId)));
}

/**
 * Why this card is dead, in plain words, or null while it is valid. `skipLive` leaves out a permission card whose run is alive.
 * A question card that is how the owner checks a merged ticket (a criterion, steps or an add-on setup) outlives its ticket's merge by design.
 */
export async function cardInvalidReason(db: Db, d: CardRow): Promise<string | null> {
  const c = d.context as Ctx;
  const isPlan = c.plan === true;
  if (c.type === "engagement" && typeof c.engagementId === "string") {
    // The owner's approval row lives only while the engagement still waits for it; a withdrawn or declined one is over.
    const [e] = await db.select({ status: engagements.status }).from(engagements).where(eq(engagements.id, c.engagementId));
    return !e || e.status === "requested" || e.status === "countered" ? null : `the engagement is ${e.status.replace("_", " ")}`;
  }
  if (await holdsLiveRun(db, d.context)) return null;
  const ts = await cardTickets(db, d);
  const afterMerge = !isPlan && (c.criterionIndexes !== undefined || c.steps !== undefined || c.setsUp !== undefined);
  // BOS-1755: a card only the owner can answer is never closed because its ticket finished: the owner may be reading it
  // (the Jenkins card vanished that way). It stays open until they answer; closeInvalidCards labels it.
  if (isOwnerOnly(c)) return null;
  if (ts.length && !afterMerge) {
    if (ts.every((t) => t.state === "done")) return `its ticket "${ts[0]!.title}" is finished`;
    if (ts.every((t) => t.state === "done" || t.mergeCommit)) return `its ticket "${ts[0]!.title}" is merged`;
  }
  if (!isPlan || !ts.length) return null;
  const t = ts[0]!;
  if (t.state === "review") return `work already built without this plan: "${t.title}" is in review`;
  if (t.planApprovedAt && t.planApprovedAt.getTime() > d.createdAt.getTime()) return "the plan was already approved on another card";
  const [newer] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.companyId, d.companyId), eq(decisions.status, "open"), ne(decisions.id, d.id), sql`${decisions.createdAt} > ${d.createdAt}`, sql`${decisions.context}->>'ticketId' = ${t.id}`, sql`${decisions.context}->>'plan' = 'true'`, sql`${decisions.context}->>'type' in ('permission', 'question')`))
    .limit(1);
  return newer ? `superseded by ${newer.id}` : null;
}

/** Card types that are about a ticket's merge or review loop: they stay in the owner's list while being re-checked. */
const MERGE_OR_REVIEW_TYPES = new Set(["review_loop", "risk_review", "check_stuck", "review_stall"]);

/**
 * Which of these cards are folded away from the owner's list while they are re-checked (BOS-1193, DR-054 point 4): a card in
 * the author's or the CEO's stage, unless it is urgent (a stored urgent mark, or a ladder alert), a request holding a live run,
 * or a merge/review-loop card. A lapsed card is not hidden. The Decisions list and the Board both use this, so they agree.
 */
export async function hiddenWhileRechecked(db: Db, cards: Array<{ id: string; staleAt: Date | null; recheckStage: string | null; context: unknown }>): Promise<Set<string>> {
  const checking = cards.filter((c) => c.staleAt && (c.recheckStage === "author" || c.recheckStage === "ceo"));
  if (!checking.length) return new Set();
  const runIds = [...new Set(checking.map((c) => (c.context as Ctx).runId).filter((r): r is string => typeof r === "string" && UUID_RE.test(r)))];
  const live = new Set(runIds.length ? (await db.select({ id: runs.id }).from(runs).where(and(inArray(runs.id, runIds), isNull(runs.endedAt)))).map((r) => r.id) : []);
  return new Set(
    checking
      .filter((c) => {
        const x = c.context as Ctx & { urgentPush?: unknown; ladder?: unknown };
        const visible = !!x.urgentPush || !!x.ladder || MERGE_OR_REVIEW_TYPES.has(x.type ?? "") || (x.type === "permission" && typeof x.runId === "string" && live.has(x.runId));
        return !visible;
      })
      .map((c) => c.id),
  );
}

export type CloseDeps = {
  /** Marks the card's notification read and takes its push off the phone; default is decisions.ts markDecisionNotificationRead. */
  markRead?: (decisionId: string, at: Date) => Promise<unknown>;
  /** Moves a ticket that waited on the card back to ready once nothing else holds it, and wakes its assignee; default moves it without the wake. */
  release?: (ticketId: string) => Promise<unknown>;
  now?: () => Date;
  /** The card that replaced this one (BOS-1219), stored on the withdrawal so screens can name it without parsing the note. */
  newer?: { id: string; author: string | null; at: string };
};

/** A ticket that waited only on closed cards, tickets and engagements goes back to ready (the same test as decisions.ts releaseIfFree). */
async function releaseWhenFree(db: Db, ticketId: string, at: Date) {
  if ((await openBlockers(db, ticketId)).length) return null;
  return systemMoveTicket(db, { ticketId, from: ["blocked"], to: "ready", reason: "Boss Man: its last blocker finished", now: at });
}

/**
 * Closes one open card by Boss Man's own say-so: withdrawn by "system" with the reason, never answered. Revokes the card's
 * approve links, takes its notification off the phone, drops the ticket hold and releases the ticket. False when the card was
 * no longer open (someone answered first).
 */
export async function closeCardBySystem(db: Db, d: { id: string; companyId: string; question: string }, note: string, deps: CloseDeps): Promise<boolean> {
  const at = (deps.now ?? (() => new Date()))();
  const closed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(decisions)
      .set({ status: "withdrawn", answeredAt: at, dedupeKey: null, recheckStage: null, context: mergeContext({ withdrawn: { by: "system", note, at: at.toISOString(), ...(deps.newer ? { newer: deps.newer } : {}) } }) })
      .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (row) await revokeApproveTokens(tx as unknown as Db, d.id, at);
    return row;
  });
  if (!closed) return false;
  // Loaded here, not at the top: decisions.ts imports this module, and the settled-card listener lives there.
  await (deps.markRead ?? (async (id: string, when: Date) => (await import("./decisions.js")).markDecisionNotificationRead(db, id, when)))(d.id, at);
  const freed = await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, d.id)).returning({ ticketId: ticketDependencies.blockedTicketId });
  for (const f of freed) if (f.ticketId) await (deps.release ? deps.release(f.ticketId) : releaseWhenFree(db, f.ticketId, at));
  const ticketId = freed.find((f) => f.ticketId)?.ticketId;
  await record(db, { companyId: d.companyId, ...(ticketId ? { ticketId } : {}), kind: "decision_withdrawn", summary: `Boss Man closed "${d.question.slice(0, 120)}" by itself: ${note}`, at });
  return true;
}

/**
 * BOS-1755: an owner-only card whose ticket has finished stays open; it is labelled once (context.keptOpen) so the
 * screen can say the ticket is done but the owner's answer is still wanted. The ticket is not reopened.
 */
async function labelKeptOpen(db: Db, d: CardRow, deps: CloseDeps) {
  const c = d.context as Ctx;
  if (!isOwnerOnly(c) || c.keptOpen) return;
  const ts = await cardTickets(db, d);
  if (!ts.length || !ts.every((t) => t.state === "done" || t.mergeCommit)) return;
  const at = (deps.now ?? (() => new Date()))();
  const cancelled = ts.every((t) => t.state === "done" && t.outcome === "cancelled");
  const note = cancelled
    ? `Its ticket "${ts[0]!.title}" was cancelled, but this question is yours alone and nobody has answered it, so it stays open until you answer or dismiss it.`
    : `Its ticket "${ts[0]!.title}" is finished, but this question is yours alone and nobody has answered it, so it stays open until you do.`;
  await db.update(decisions).set({ context: mergeContext({ keptOpen: { note, at: at.toISOString() } }) }).where(and(eq(decisions.id, d.id), eq(decisions.status, "open")));
}

/**
 * Runs the table over open cards (every checkable agent card in the company, or the ones named) and closes the dead ones.
 * Returns how many it closed. The first run after a deploy also clears the leftovers the older flagging left behind.
 */
export async function closeInvalidCards(db: Db, deps: CloseDeps = {}, input: { companyId?: string; ids?: string[] } = {}): Promise<number> {
  const rows = await db
    .select({ id: decisions.id, companyId: decisions.companyId, createdAt: decisions.createdAt, question: decisions.question, context: decisions.context })
    .from(decisions)
    .where(and(eq(decisions.status, "open"), checkableCard, ...(input.companyId ? [eq(decisions.companyId, input.companyId)] : []), ...(input.ids ? [inArray(decisions.id, input.ids)] : [])));
  let closed = 0;
  for (const d of rows) {
    const reason = await cardInvalidReason(db, d);
    if (reason && (await closeCardBySystem(db, d, reason, deps))) closed++;
    else if (!reason) await labelKeptOpen(db, d, deps);
  }
  return closed;
}
