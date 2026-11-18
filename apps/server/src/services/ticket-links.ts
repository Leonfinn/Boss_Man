// Ticket dependencies (BOS-86 round 12): one guarded writer for every row in `ticket_dependencies`
// and every move it makes. Rounds 8-12 closed one route at a time; this is the data layer, so a new
// tool or service can't reopen the hole by forgetting its own check.
import { and, eq, sql } from "drizzle-orm";
import { unreportedAfterMerge } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { decisions, engagements, tickets, ticketDependencies } from "../db/schema.js";
import { reviewTicketWriteRefusal } from "./skill-proposals.js";
import { systemMoveTicket } from "./ticket-transition.js";

export class WorkError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Which field a 409 is about, so the page can offer a reload for it (BOS-905). */
    readonly field?: string,
  ) {
    super(message);
  }
}

/**
 * Whether a ticket blocker has finished for the ticket waiting on it (BOS-989): done always counts; a link
 * that waits "until merged" is also free once the blocker's merge commit is on main.
 */
export function ticketBlockerFinished(d: { ticketState: string | null; mergeCommit: string | null; until: string }): boolean {
  return d.ticketState === "done" || (d.until === "merged" && !!d.mergeCommit);
}

export { ticketBlockerOpenSql } from "./blocker-sql.js";

export type OpenBlocker = { kind: "ticket" | "engagement" | "decision"; title: string | null };

/**
 * What still holds a ticket (BOS-1458): the one answer for starting it, blocking it, waking an urgent one
 * and creating it. A blocker ticket is free by `ticketBlockerFinished` (merged counts when the link waits
 * until merged); an engagement is open until signed off; a decision is open until answered.
 */
export async function openBlockers(db: Db, ticketId: string): Promise<OpenBlocker[]> {
  const deps = await db
    .select({ ticketState: tickets.systemState, ticketTitle: tickets.title, mergeCommit: tickets.mergeCommit, until: ticketDependencies.until, engagementStatus: engagements.status, decisionStatus: decisions.status })
    .from(ticketDependencies)
    .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
    .leftJoin(engagements, eq(engagements.id, ticketDependencies.blockerEngagementId))
    .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
    .where(eq(ticketDependencies.blockedTicketId, ticketId));
  const open: OpenBlocker[] = [];
  for (const d of deps) {
    if (d.ticketState && !ticketBlockerFinished(d)) open.push({ kind: "ticket", title: d.ticketTitle });
    else if (d.engagementStatus && d.engagementStatus !== "signed_off") open.push({ kind: "engagement", title: null });
    else if (d.decisionStatus === "open") open.push({ kind: "decision", title: null });
  }
  return open;
}

/** The open cards that name this ticket (a plan card, a permission card or a question), linked or not. */
export async function openCardIds(db: Db, ticketId: string): Promise<string[]> {
  const rows = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'ticketId' = ${ticketId}`));
  return rows.map((r) => r.id);
}

/** True when the ticket has merged and still has after-merge criteria without a reported pass or fail. */
export async function mergedAwaitingChecks(db: Db, ticketId: string): Promise<boolean> {
  const [t] = await db.select({ mergeCommit: tickets.mergeCommit, criteria: tickets.acceptanceCriteria, note: tickets.stateNote }).from(tickets).where(eq(tickets.id, ticketId));
  return !!t?.mergeCommit && unreportedAfterMerge(t.criteria, t.note).length > 0;
}

export type BlockedHold = { kind: "date" | "blocker" | "card" | "go_live" };

/**
 * DR-061 Q2a, the one answer to "is this ticket held in Blocked?" (BOS-1532): what Blocked accepts on the way in
 * and what it must keep on the way out are the same list. Held while any of these is true: a "blocked until" time
 * still ahead; an open blocker (`openBlockers`); an open card naming the ticket, linked or not; a go-live wait (a merged
 * ticket not yet live; once it is live its after-merge checks hold nothing, R36). An empty list means nothing holds it.
 *
 * `blockedUntil` is the date to judge: pass the one being set on the way in (null for none); leave it out to read
 * the stored one. A date that has passed holds nothing. A state note that says "parked" is not a hold here: the
 * scheduler's release tells the assignee about it and leaves the ticket where it is (BOS-742).
 */
export async function blockedHolds(db: Db, ticketId: string, opts: { now?: Date; blockedUntil?: Date | null } = {}): Promise<BlockedHold[]> {
  const at = opts.now ?? new Date();
  const [t] = await db.select({ blockedUntil: tickets.blockedUntil, goLiveWait: tickets.goLiveWait }).from(tickets).where(eq(tickets.id, ticketId));
  const until = opts.blockedUntil !== undefined ? opts.blockedUntil : (t?.blockedUntil ?? null);
  const holds: BlockedHold[] = [];
  if (until && until.getTime() > at.getTime()) holds.push({ kind: "date" });
  if ((await openBlockers(db, ticketId)).length) holds.push({ kind: "blocker" });
  if ((await openCardIds(db, ticketId)).length) holds.push({ kind: "card" });
  // R36 (BOS-1679): a merged ticket's after-merge checks hold it only until it is live (the go-live wait, which wakes the
  // assignee). After that nothing ends such a hold, so a ticket whose checks need someone must link them or use a date.
  if (t?.goLiveWait) holds.push({ kind: "go_live" });
  return holds;
}

/** Who is asking for the link: an agent's run, or the system acting on its own (loop guards, risk sign-off). */
export type LinkActor = { type: "agent"; agentId: string | null } | { type: "system" };

export type DependencyWrite = {
  companyId: string;
  blockedTicketId: string;
  blockerTicketId?: string | null;
  blockerDecisionId?: string | null;
  blockerEngagementId?: string | null;
  actor: LinkActor;
  /** For a ticket blocker: finished when it is merged or when it is done (BOS-989). Default done, as links always were. */
  until?: "merged" | "done";
  /** Move the blocked ticket to blocked in the same call (a decision or a loop guard holding it). */
  hold?: boolean;
  now?: () => Date;
};

/** Refuses when this ticket is an open skill-review task and the agent isn't the reviewer assigned to it. */
async function refuseReviewWrite(db: Db, companyId: string, ticketId: string, agentId: string | null) {
  const refusal = await reviewTicketWriteRefusal(db, companyId, ticketId, agentId);
  if (refusal) throw new WorkError(403, refusal);
}

/** Both ends of the link are checked: attaching anything to a review task, or making it wait, is a write. */
async function assertLinkAllowed(db: Db, input: DependencyWrite) {
  if (input.actor.type === "agent") {
    await refuseReviewWrite(db, input.companyId, input.blockedTicketId, input.actor.agentId);
    if (input.blockerTicketId) await refuseReviewWrite(db, input.companyId, input.blockerTicketId, input.actor.agentId);
    return;
  }
  // A system hold must come from the system's own decision. A decision an agent raised is that
  // agent's text, so the agent is the actor and the review gate applies to it (round 12's hole:
  // raise_decision with blocksTicketId aimed at the reviewer's task).
  if (!input.blockerDecisionId) return;
  const [d] = await db.select({ raisedBy: decisions.raisedByAgentId }).from(decisions).where(eq(decisions.id, input.blockerDecisionId));
  if (!d) throw new WorkError(404, "No such decision.");
  await refuseReviewWrite(db, input.companyId, input.blockedTicketId, d.raisedBy);
}

/**
 * The only writer of `ticket_dependencies`. Company-checks both ends, applies the review-task gate,
 * inserts the row and (with `hold`) blocks the waiting ticket. Callers record their own activity.
 */
export async function addTicketDependency(db: Db, input: DependencyWrite) {
  const blockers = [input.blockerTicketId, input.blockerDecisionId, input.blockerEngagementId].filter(Boolean).length;
  if (blockers !== 1) throw new WorkError(422, "Give exactly one blocker: a ticket, a decision or an engagement.");
  const [blocked] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.id, input.blockedTicketId), eq(tickets.companyId, input.companyId)));
  if (!blocked) throw new WorkError(404, "No such ticket in this company.");
  if (input.blockerTicketId) {
    if (input.blockerTicketId === input.blockedTicketId) throw new WorkError(422, "A ticket can't block itself.");
    const [b] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.id, input.blockerTicketId), eq(tickets.companyId, input.companyId)));
    if (!b) throw new WorkError(422, "The blocking ticket must be in the same company. Use an engagement to wait on another company.");
  }
  await assertLinkAllowed(db, input);
  const [dep] = await db
    .insert(ticketDependencies)
    .values({
      blockedTicketId: input.blockedTicketId,
      blockerTicketId: input.blockerTicketId ?? null,
      blockerDecisionId: input.blockerDecisionId ?? null,
      blockerEngagementId: input.blockerEngagementId ?? null,
      until: input.blockerTicketId ? (input.until ?? "done") : "done",
    })
    .returning();
  if (input.hold) {
    // DR-047 point 3 (BOS-919): an agent's card only blocks work that hasn't been handed in. A ticket in review
    // or done keeps its state; the row above still links the card (the board shows it in Your review), landOnce
    // waits for the card (openHoldingCard), and answering it leaves the ticket where it is, so no new review round.
    // The system's own hold (the stuck-review guard, R49) is left as it was: it stops a review on purpose.
    await systemMoveTicket(db, {
      ticketId: input.blockedTicketId,
      from: input.actor.type === "agent" ? ["backlog", "ready", "in_progress", "blocked"] : undefined,
      to: "blocked",
      reason: input.blockerTicketId ? "Boss Man: held by a ticket it depends on" : input.blockerDecisionId ? `Waiting on the owner's card ${input.blockerDecisionId}` : "Boss Man: held by an engagement",
      now: (input.now ?? (() => new Date()))(),
    });
  }
  return dep!;
}

/**
 * Which linked cards hold an approved ticket's merge (BOS-1078). The one rule, used by the merge gate
 * (openHoldingCard) and the Merge queue screen alike, so the screen can never name a card the gate ignores:
 * - the stuck-review guard (`review_loop`), the system's own stop;
 * - an agent's card raised with `holdsMerge` (raise_decision with blocksTicketId and holdsMerge: true): the
 *   raiser said on purpose that it must be answered before the code goes in.
 * Any other card linked to the ticket (a plain question, an owner to-do, an after-merge check, a plan card)
 * stays linked, so it is still in the owner's queue and the Your review lane, but it does not hold the merge:
 * the reviews and the owner's sign-off are the merge's gate (BOS-919 had kept every question as a hold).
 * The owner's sign-off card, a reviewer's hold and the merge's own cards have their own checks. The carried-work
 * card is left out on purpose: Boss Man starts that merge again by itself once the carried ticket lands (BOS-733).
 */
export const holdsMergeSql = sql`(${decisions.context}->>'type' = 'review_loop' or (${decisions.context}->>'type' = 'question' and ${decisions.context}->>'holdsMerge' = 'true'))`;

/**
 * BOS-1755: a ticket's own owner-only question (owner_choice, owner_setup, secret...) that blocks it holds it in
 * "Passed, held" (a merge for a code ticket, closing for a no-code one) until the owner answers it. A plan card and an after-merge card (criterion, steps or setsUp: the owner does those after the code is live) never hold, or the ticket would deadlock.
 */
export const ownerOnlyQuestionSql = sql`(${decisions.context}->>'type' = 'question' and ${decisions.context}->>'ownerOnly' is not null and coalesce(${decisions.context}->>'plan', '') <> 'true' and ${decisions.context}->'criterionIndexes' is null and ${decisions.context}->'steps' is null and ${decisions.context}->'setsUp' is null)`;

/** The ticket's own open owner-only question card that blocks it (ownerOnlyQuestionSql), or null. A ticket can't be closed as completed while one is open. */
export async function openOwnerOnlyCard(db: Db, ticketId: string): Promise<string | null> {
  const [d] = await db
    .select({ id: decisions.id })
    .from(ticketDependencies)
    .innerJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
    .where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(decisions.status, "open"), ownerOnlyQuestionSql))
    .limit(1);
  return d?.id ?? null;
}

/** An open card that holds this ticket's merge (see holdsMergeSql), or null. A ticket is also held by its own owner-only card. */
export async function openHoldingCard(db: Db, ticketId: string): Promise<string | null> {
  const [d] = await db
    .select({ id: decisions.id })
    .from(ticketDependencies)
    .innerJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
    .where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(decisions.status, "open"), sql`(${holdsMergeSql} or ${ownerOnlyQuestionSql})`))
    .limit(1);
  return d?.id ?? null;
}
