// Ticket dependencies (BOS-86 round 12): one guarded writer for every row in `ticket_dependencies`
// and every move it makes. Rounds 8-12 closed one route at a time; this is the data layer, so a new
// tool or service can't reopen the hole by forgetting its own check.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions, tickets, ticketDependencies } from "../db/schema.js";
import { reviewTicketWriteRefusal } from "./skill-proposals.js";
import { systemMoveTicket } from "./ticket-transition.js";

export class WorkError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
    })
    .returning();
  if (input.hold) {
    await systemMoveTicket(db, {
      ticketId: input.blockedTicketId,
      to: "blocked",
      reason: input.blockerTicketId ? "held by a ticket it depends on" : input.blockerDecisionId ? "held by a decision" : "held by an engagement",
      now: (input.now ?? (() => new Date()))(),
    });
  }
  return dep!;
}
