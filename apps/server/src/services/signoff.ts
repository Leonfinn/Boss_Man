// The owner's sign-off on a ticket (R48, BOS-446, DR-013, BOS-503, DR-021). "Waiting on the owner's sign-off" is
// worked out from the facts: the review policy, the latest review round and the recorded sign-off. The card only
// shows that state. A ticket that waits with no open card (lost, never raised, the policy switched on after the
// reviews) is "missing": the sweep raises the card again, and no merge path lands it in the meantime.
import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { RISK_TIERS, riskOf, ruleFor, type RiskTier } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, decisions, ticketDependencies, ticketReviews, tickets } from "../db/schema.js";
import { APPROVE_MERGE, supersedeSignoffs } from "./decisions.js";
import { evaluate, latestRows } from "./review-kinds.js";
import { effectivePolicy } from "./review-policy.js";
import { addTicketDependency } from "./ticket-links.js";
import { record } from "./activity.js";

type Ticket = typeof tickets.$inferSelect;
export type SignedOff = { head: string; risk: string | null; at: string };

/** From the facts alone, with no regard to cards that are open. */
export type DerivedSignoff =
  /** The policy doesn't ask the owner for this ticket's risk. */
  | { state: "not_needed" }
  /** Reviews are still running, or failed: nothing to sign off yet. */
  | { state: "reviews_pending" }
  /** Every review passed and the owner hasn't signed off this round (or this commit). */
  | { state: "waiting"; since: Date; reviewer: string; reviewerAgentId: string | null }
  /** The owner signed off; `head` is the commit they signed off, when it is known. */
  | { state: "signed_off"; at: Date; head: string | null };

/** For people: the derived state with the card on top. */
export type SignoffState =
  | { state: "waiting"; cardId: string; since: Date }
  | { state: "missing"; since: Date; reviewer: string; reviewerAgentId: string | null }
  | { state: "signed_off"; at: Date; head: string | null }
  | { state: "none" };

/** The open sign-off card for a ticket, if there is one. */
export async function openSignoffCard(db: Db, ticketId: string): Promise<string | null> {
  const [d] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`))
    .orderBy(desc(decisions.createdAt))
    .limit(1);
  return d?.id ?? null;
}

/**
 * The owner's last commit sign-off on this ticket, and whether it covers `head` (DR-013). It is reused only when the
 * newest answered sign-off card is an "Approve and merge" for the same commit, nobody sent the ticket back since (the
 * card's "Send it back" makes a newer answered card; the review page and reviewers leave a changes-requested
 * ticket_reviews row), and the risk is no higher than what the owner saw. `earlier` names the last signed-off commit.
 */
export async function priorSignoff(db: Db, t: { id: string; risk: RiskTier | null }, head: string | null): Promise<{ reuse: SignedOff | null; earlier: SignedOff | null; current: SignedOff | null }> {
  const cards = await db
    .select({ answer: decisions.answer, context: decisions.context })
    .from(decisions)
    .where(and(eq(decisions.status, "answered"), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${t.id}`))
    .orderBy(desc(decisions.answeredAt));
  const signed = cards.find((c) => c.answer === APPROVE_MERGE && (c.context as { signedOff?: SignedOff }).signedOff);
  const earlier = signed ? (signed.context as { signedOff: SignedOff }).signedOff : null;
  // `current`: the newest sign-off still stands (not sent back, risk not raised), whatever commit it covers.
  let current: SignedOff | null = null;
  if (earlier && cards[0] === signed && earlier.risk && RISK_TIERS.indexOf(riskOf(t.risk)) <= RISK_TIERS.indexOf(earlier.risk as RiskTier)) {
    const [sentBack] = await db
      .select({ id: ticketReviews.id })
      .from(ticketReviews)
      .where(and(eq(ticketReviews.ticketId, t.id), eq(ticketReviews.verdict, "changes_requested"), gt(ticketReviews.createdAt, new Date(earlier.at))))
      .limit(1);
    if (!sentBack) current = earlier;
  }
  return { reuse: current && head && current.head === head ? current : null, earlier, current };
}

/**
 * Where the ticket stands on the owner's sign-off, from the facts (DR-021). With `head` (a merge about to land
 * that commit), a commit sign-off counts only for that commit. Without it (board, sweep, page), a sign-off counts
 * when it came after the last review, or when that review's approval reused it for the same commit (DR-013).
 */
export async function derivedSignoff(db: Db, t: Ticket, head?: string | null): Promise<DerivedSignoff> {
  if (!ruleFor(await effectivePolicy(db, t), t.risk).ownerSignoff) return { state: "not_needed" };
  const [latest] = await db.select({ reviewer: ticketReviews.reviewer, verdict: ticketReviews.verdict, at: ticketReviews.createdAt }).from(ticketReviews).where(eq(ticketReviews.ticketId, t.id)).orderBy(desc(ticketReviews.createdAt)).limit(1);
  const rows = await latestRows(db, t.id);
  // The owner's own approval (the ticket page or review page, with no card) is the sign-off when it is the
  // ticket's newest review verdict and no review round started after it: approve() records it moments before
  // the merge starts. It still counts while that round's reviews are open (the owner may approve over them), but
  // an approval from an earlier round never signs off the next one (Freddy's round-1 finding: it used to).
  const roundStart = rows.length ? Math.max(...rows.map((r) => r.createdAt.getTime())) : 0;
  if (latest?.reviewer === "the owner" && latest.verdict === "approved" && latest.at.getTime() >= roundStart) return { state: "signed_off", at: latest.at, head: null };
  const prior = await priorSignoff(db, t, head ?? null);
  if (head && prior.reuse) return { state: "signed_off", at: new Date(prior.reuse.at), head: prior.reuse.head };
  // With no review requests (a policy with no review kinds), the approval itself is the round: an agent's approval
  // as the ticket's newest verdict, recorded by review.approve before it raised the card.
  let since: Date;
  if (rows.length) {
    if (evaluate(rows) !== "passed") return { state: "reviews_pending" };
    since = new Date(Math.max(...rows.map((r) => (r.decidedAt ?? r.createdAt).getTime())));
  } else if (latest?.verdict === "approved") since = latest.at;
  else return { state: "reviews_pending" };
  if (!head && prior.current) {
    if (new Date(prior.current.at) >= since) return { state: "signed_off", at: new Date(prior.current.at), head: prior.current.head };
    // The last round's approval reused the sign-off for the same commit (review.approve records it).
    const [reused] = await db.select({ id: activity.id }).from(activity).where(and(eq(activity.ticketId, t.id), eq(activity.kind, "signoff_reused"), gte(activity.at, since))).limit(1);
    if (reused) return { state: "signed_off", at: new Date(prior.current.at), head: prior.current.head };
  }
  // A card answered with no commit on record (raised before DR-013, or when the runner couldn't say the head):
  // answered after the last review, it signs off that round.
  const [legacy] = await db
    .select({ at: decisions.answeredAt })
    .from(decisions)
    .where(and(eq(decisions.status, "answered"), eq(decisions.answer, APPROVE_MERGE), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${t.id}`, sql`${decisions.context}->>'head' is null`, gte(decisions.answeredAt, since)))
    .orderBy(desc(decisions.answeredAt))
    .limit(1);
  if (legacy?.at) return { state: "signed_off", at: legacy.at, head: null };
  const approvers = [...new Set(rows.filter((r) => r.status === "approved" && r.reviewerAgentId).map((r) => r.reviewerAgentId!))];
  const names = approvers.length ? (await db.select({ name: agents.name }).from(agents).where(inArray(agents.id, approvers))).map((a) => a.name) : [];
  const last = [...rows].filter((r) => r.reviewerAgentId).sort((a, b) => (b.decidedAt ?? b.createdAt).getTime() - (a.decidedAt ?? a.createdAt).getTime())[0];
  return { state: "waiting", since, reviewer: names.length ? names.join(" and ") : (latest?.reviewer ?? "The reviewers"), reviewerAgentId: last?.reviewerAgentId ?? null };
}

/** Where a ticket in review stands, for the board, the page and the tools: the derived state plus its card. */
export async function signoffState(db: Db, t: Ticket): Promise<SignoffState> {
  if (t.systemState !== "review") return { state: "none" };
  const d = await derivedSignoff(db, t);
  if (d.state === "signed_off") return d;
  if (d.state !== "waiting") return { state: "none" };
  const open = await openSignoffCard(db, t.id);
  if (open) return { state: "waiting", cardId: open, since: d.since };
  return { state: "missing", since: d.since, reviewer: d.reviewer, reviewerAgentId: d.reviewerAgentId };
}

const hhmm = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** One line for the CEO's and agents' tools. */
export function signoffLine(s: SignoffState): string {
  if (s.state === "waiting") return `Owner sign-off: waiting on the owner since ${hhmm(s.since)} (card ${s.cardId}, in their Decisions and the board's Your review lane).`;
  if (s.state === "missing") return `Owner sign-off: waiting on the owner since ${hhmm(s.since)}, but no card is open; Boss Man raises it on its next sweep, and nothing merges it meanwhile.`;
  if (s.state === "signed_off") return `Owner sign-off: signed off at ${hhmm(s.at)}${s.head ? ` for commit ${s.head.slice(0, 8)}` : ""}; it merges next.`;
  return "Owner sign-off: not waiting on it (not needed, or the reviews aren't all in).";
}

/** The ticket's last few sign-off cards and how each closed, so a lost card can be traced from the ticket. */
export async function signoffHistory(db: Db, ticketId: string, limit = 5): Promise<string | null> {
  const rows = await db
    .select({ id: decisions.id, status: decisions.status, answer: decisions.answer, createdAt: decisions.createdAt, answeredAt: decisions.answeredAt, context: decisions.context })
    .from(decisions)
    .where(and(sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`))
    .orderBy(desc(decisions.createdAt))
    .limit(limit);
  if (!rows.length) return null;
  const lines = rows.map((r) => {
    const c = r.context as { head?: string; withdrawn?: { by?: string; note?: string }; settledBy?: unknown };
    const how =
      r.status === "open"
        ? "open"
        : r.status === "answered"
          ? `answered "${r.answer}"${r.answeredAt ? ` at ${hhmm(r.answeredAt)}` : ""}`
          : `${r.status}${r.answeredAt ? ` at ${hhmm(r.answeredAt)}` : ""}${c.withdrawn ? ` by ${c.withdrawn.by ?? "?"}: ${c.withdrawn.note ?? ""}` : ""}`;
    return `  - ${r.id}, raised ${hhmm(r.createdAt)}${c.head ? ` for ${c.head.slice(0, 8)}` : ""}: ${how}`;
  });
  return `Sign-off history (newest first):\n${lines.join("\n")}`;
}

/**
 * Raises the one "Merge it, or send it back?" card for a ticket and holds the ticket on it. Any older open
 * sign-off card is closed first, so there is never more than one per ticket (BOS-446); all three in one
 * transaction, so a crash can't leave a card without its hold or a hold without its card. The card closes
 * itself once the ticket stops waiting on the sign-off (`signoffNotWaiting`, DR-021).
 */
export async function raiseSignoffCard(db: Db, t: Ticket, o: { reviewer: string; reviewerAgentId: string | null; head?: string | null; earlier?: SignedOff | null }): Promise<string> {
  const earlier = o.earlier ? `\n\nYou approved an earlier version (${o.earlier.head.slice(0, 8)}) on ${hhmm(new Date(o.earlier.at))}; the code has changed since.` : "";
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    await supersedeSignoffs(tx, t.id, { by: "system", note: "Replaced by a newer sign-off card after a new review round.", at: new Date().toISOString() });
    const [d] = await tx
      .insert(decisions)
      .values({
        companyId: t.companyId,
        kind: "approval",
        question: `${o.reviewer} approved "${t.title}", which is rated ${riskOf(t.risk)} risk. Merge it, or send it back?${earlier}`,
        options: [APPROVE_MERGE, "Send it back"],
        recommendedOption: APPROVE_MERGE,
        raisedByAgentId: o.reviewerAgentId,
        tier: "owner",
        dedupeKey: `risk-review:${t.id}:${Date.now()}`,
        context: { type: "risk_review", ticketId: t.id, reviewer: o.reviewer, ...(o.head ? { head: o.head, risk: riskOf(t.risk) } : {}), clearWhen: [{ kind: "signoffNotWaiting", ticketId: t.id }] },
      })
      .returning({ id: decisions.id });
    await addTicketDependency(tx, { companyId: t.companyId, blockedTicketId: t.id, blockerDecisionId: d!.id, actor: { type: "system" } });
    return d!.id;
  });
}

/**
 * Makes the cards match the state (DR-021): a ticket that waits gets exactly one open card (raised if none),
 * and the CEO hears once per card raised here. Returns the raised card's id, or null when none was needed
 * (so a second call, or a race with a fresh approval, adds nothing). Cards on tickets that no longer wait
 * are closed by their own `signoffNotWaiting` condition.
 */
export async function restoreSignoffCard(db: Db, t: Ticket, why: string, head?: string | null): Promise<string | null> {
  const s = await signoffState(db, t);
  if (s.state !== "missing") return null;
  const id = await raiseSignoffCard(db, t, { reviewer: s.reviewer, reviewerAgentId: s.reviewerAgentId, head });
  await record(db, { companyId: t.companyId, ticketId: t.id, kind: "signoff_restored", summary: `Every review passed but no sign-off card was open, so Boss Man raised one (${why}).` });
  return id;
}

/** Two raises that raced (an approval and the sweep, say) can leave two open cards: keep the newest. */
async function closeExtraCards(db: Db, ticketId: string) {
  const open = await db
    .select({ id: decisions.id, context: decisions.context })
    .from(decisions)
    .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`))
    .orderBy(desc(decisions.createdAt));
  for (const extra of open.slice(1)) {
    const at = new Date().toISOString();
    const [done] = await db
      .update(decisions)
      .set({ status: "withdrawn", answeredAt: new Date(at), dedupeKey: null, context: { ...(extra.context as object), withdrawn: { by: "system", note: "A second sign-off card for the same ticket; the newer one stays open.", at } } })
      .where(and(eq(decisions.id, extra.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (done) await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, extra.id));
  }
}

/** Whether an open sign-off card's cause is gone, in plain words, or null while the ticket still waits. */
export async function signoffClearedReason(db: Db, ticketId: string): Promise<string | null> {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t) return "the ticket is no longer on record";
  if (t.systemState === "done") return `the ticket "${t.title}" is finished`;
  if (t.systemState !== "review") return `the ticket "${t.title}" is now ${t.systemState.replace("_", " ")}`;
  const d = await derivedSignoff(db, t);
  if (d.state === "waiting") return null;
  if (d.state === "signed_off") return "the owner signed it off";
  if (d.state === "not_needed") return "its risk no longer needs the owner's sign-off";
  // reviews_pending: a new review round started, or a review in this round asked for changes.
  return "its reviews are open again (a new review round started, or a review asked for changes)";
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
    await closeExtraCards(db, t.id);
    const id = await restoreSignoffCard(db, t, "found by the sign-off sweep");
    if (!id) continue;
    raised++;
    await tellCeo?.(t.companyId, `"${t.title}" (${t.id}) passed every review and waits on the owner's sign-off, but no sign-off card was open. Boss Man raised it again (card ${id}); it is in the owner's Decisions. Nothing to do unless it stays unanswered.`).catch(() => undefined);
  }
  return raised;
}
