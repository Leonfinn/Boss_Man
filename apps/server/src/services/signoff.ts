// The owner's sign-off on a ticket (R48, BOS-446, BOS-503): one place that says whether a ticket waits on it,
// and the one way its "Merge it, or send it back?" card is raised. A ticket that needs the sign-off but has no
// open card (lost, never raised, or the policy switched on after the reviews) is "missing": the sweep raises the
// card again, and nothing merges it in the meantime.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { riskOf, ruleFor } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, ticketReviews, tickets } from "../db/schema.js";
import { APPROVE_MERGE, supersedeSignoffs } from "./decisions.js";
import { evaluate, latestRows } from "./review-kinds.js";
import { effectivePolicy } from "./review-policy.js";
import { addTicketDependency } from "./ticket-links.js";
import { record } from "./activity.js";

type Ticket = typeof tickets.$inferSelect;

export type SignoffState =
  /** The sign-off card is open: the owner answers it in Decisions or with Approve and merge on the ticket. */
  | { state: "waiting"; cardId: string }
  /** Every review passed and the policy wants the owner's sign-off, but no card is open and the owner hasn't signed off. */
  | { state: "missing"; reviewer: string; reviewerAgentId: string | null }
  /** The owner signed off on this round (on the card, or by approving it themselves). */
  | { state: "signed_off"; at: Date }
  /** Not waiting on the owner: sign-off not needed, reviews still running, or the ticket isn't in review. */
  | { state: "none" };

/** The open sign-off card for a ticket, if there is one. */
export async function openSignoffCard(db: Db, ticketId: string): Promise<string | null> {
  const [d] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`))
    .limit(1);
  return d?.id ?? null;
}

/** Where the ticket stands on the owner's sign-off. */
export async function signoffState(db: Db, t: Ticket): Promise<SignoffState> {
  if (t.systemState !== "review") return { state: "none" };
  const open = await openSignoffCard(db, t.id);
  if (open) return { state: "waiting", cardId: open };
  if (!ruleFor(await effectivePolicy(db, t), t.risk).ownerSignoff) return { state: "none" };
  const rows = await latestRows(db, t.id);
  // No agent reviews (the owner reviews it themselves), or some are still to come: nothing to sign off yet.
  if (!rows.length || evaluate(rows) !== "passed") return { state: "none" };
  const approvedAt = new Date(Math.max(...rows.map((r) => (r.decidedAt ?? r.createdAt).getTime())));
  // Signed off on this round: the card answered Approve and merge after the last review, or the owner's own approval.
  const [card] = await db
    .select({ at: decisions.answeredAt })
    .from(decisions)
    .where(and(eq(decisions.status, "answered"), eq(decisions.answer, APPROVE_MERGE), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${t.id}`, gte(decisions.answeredAt, approvedAt)))
    .orderBy(desc(decisions.answeredAt))
    .limit(1);
  if (card?.at) return { state: "signed_off", at: card.at };
  const [own] = await db
    .select({ at: ticketReviews.createdAt })
    .from(ticketReviews)
    .where(and(eq(ticketReviews.ticketId, t.id), eq(ticketReviews.reviewer, "the owner"), eq(ticketReviews.verdict, "approved"), gte(ticketReviews.createdAt, approvedAt)))
    .limit(1);
  if (own) return { state: "signed_off", at: own.at };
  const approvers = [...new Set(rows.filter((r) => r.status === "approved" && r.reviewerAgentId).map((r) => r.reviewerAgentId!))];
  const names = approvers.length ? (await db.select({ name: agents.name }).from(agents).where(inArray(agents.id, approvers))).map((a) => a.name) : [];
  const last = [...rows].filter((r) => r.reviewerAgentId).sort((a, b) => (b.decidedAt ?? b.createdAt).getTime() - (a.decidedAt ?? a.createdAt).getTime())[0];
  return { state: "missing", reviewer: names.length ? names.join(" and ") : "The reviewers", reviewerAgentId: last?.reviewerAgentId ?? null };
}

/** One line for the CEO's and agents' tools. */
export function signoffLine(s: SignoffState): string | null {
  if (s.state === "waiting") return `Owner sign-off: waiting on the owner (card ${s.cardId}, in their Decisions and the board's Your review lane).`;
  if (s.state === "missing") return "Owner sign-off: needed but no card is open; Boss Man raises it on its next sweep.";
  if (s.state === "signed_off") return `Owner sign-off: signed off at ${s.at.toISOString().slice(0, 16).replace("T", " ")} UTC; it merges next.`;
  return null;
}

/**
 * Raises the one "Merge it, or send it back?" card for a ticket and holds the ticket on it. Any older open
 * sign-off card is closed first, so there is never more than one per ticket (BOS-446).
 */
export async function raiseSignoffCard(db: Db, t: Ticket, o: { reviewer: string; reviewerAgentId: string | null }): Promise<string> {
  await supersedeSignoffs(db, t.id, { by: "system", note: "Replaced by a newer sign-off card after a new review round.", at: new Date().toISOString() });
  const [d] = await db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "approval",
      question: `${o.reviewer} approved "${t.title}", which is rated ${riskOf(t.risk)} risk. Merge it, or send it back?`,
      options: [APPROVE_MERGE, "Send it back"],
      recommendedOption: APPROVE_MERGE,
      raisedByAgentId: o.reviewerAgentId,
      tier: "owner",
      dedupeKey: `risk-review:${t.id}:${Date.now()}`,
      context: { type: "risk_review", ticketId: t.id, reviewer: o.reviewer },
    })
    .returning({ id: decisions.id });
  await addTicketDependency(db, { companyId: t.companyId, blockedTicketId: t.id, blockerDecisionId: d!.id, actor: { type: "system" } });
  return d!.id;
}

/**
 * Raises the card for a ticket whose sign-off is "missing", and says so on the ticket. Returns the new card's
 * id, or null when the ticket isn't missing one (so a second call, or a race with a fresh approval, adds nothing).
 */
export async function restoreSignoffCard(db: Db, t: Ticket, why: string): Promise<string | null> {
  const s = await signoffState(db, t);
  if (s.state !== "missing") return null;
  const id = await raiseSignoffCard(db, t, { reviewer: s.reviewer, reviewerAgentId: s.reviewerAgentId });
  await record(db, { companyId: t.companyId, ticketId: t.id, kind: "signoff_restored", summary: `Every review passed but no sign-off card was open, so Boss Man raised one (${why}).` });
  return id;
}

/**
 * The sweep (BOS-503): every ticket in review that waits on the owner's sign-off with no open card gets one,
 * and the CEO is told once per card raised. Paused companies are left alone, as the other sweeps do.
 */
export async function sweepMissingSignoffs(db: Db, tellCeo?: (companyId: string, note: string) => Promise<unknown>): Promise<number> {
  const rows = await db
    .select({ t: tickets })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .where(and(eq(tickets.systemState, "review"), eq(companies.paused, false)));
  let raised = 0;
  for (const { t } of rows) {
    const id = await restoreSignoffCard(db, t, "found by the sign-off sweep");
    if (!id) continue;
    raised++;
    await tellCeo?.(t.companyId, `"${t.title}" (${t.id}) passed every review and waits on the owner's sign-off, but no sign-off card was open. Boss Man raised it again (card ${id}); it is in the owner's Decisions. Nothing to do unless it stays unanswered.`).catch(() => undefined);
  }
  return raised;
}
