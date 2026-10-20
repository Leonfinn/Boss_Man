// Reviews by kind: when a ticket enters review, every review the tier requires (the code review plus
// any security, infra or adversarial ones) is requested at once. The CEO may order them; each
// verdict is kept; the ticket passes only when all approve or the CEO has overruled the rest.
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { KIND_FOCUS, REVIEW_KINDS, ruleFor, type ReviewSlot } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, reviewRequests, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { effectivePolicy, resolveKindReviewer } from "./review-policy.js";

export type ReviewRow = typeof reviewRequests.$inferSelect;
type Ticket = typeof tickets.$inferSelect;
export type Notify = (agentId: string, input: { reason: string; note: string; priority: number; causedByRunId?: string | null }) => Promise<unknown>;
export const REVIEW_REASON = "review requested";
const SETTLED = ["approved", "overruled"];

/** The rows of the ticket's newest round. */
export async function latestRows(db: Db, ticketId: string): Promise<ReviewRow[]> {
  const [m] = await db.select({ n: max(reviewRequests.round) }).from(reviewRequests).where(eq(reviewRequests.ticketId, ticketId));
  if (!m?.n) return [];
  return db.select().from(reviewRequests).where(and(eq(reviewRequests.ticketId, ticketId), eq(reviewRequests.round, m.n))).orderBy(reviewRequests.seq, reviewRequests.kind);
}

/** Pending reviews whose turn it is. Seq 0 is never held back and holds nobody; a numbered review waits for the lower numbers to approve or be overruled. */
export const activeRows = (rows: ReviewRow[]) => rows.filter((r) => r.status === "pending" && rows.every((o) => o.seq === 0 || o.seq >= r.seq || SETTLED.includes(o.status)));

/** waiting: someone must still review. failed: nobody can, and a change was requested. passed: all approved or overruled. */
export function evaluate(rows: ReviewRow[]): "waiting" | "failed" | "passed" {
  if (activeRows(rows).length) return "waiting";
  if (rows.some((r) => r.status === "changes_requested")) return "failed";
  return rows.every((r) => SETTLED.includes(r.status)) ? "passed" : "waiting";
}

const seqOf = (order: string[] | null | undefined, kind: string) => (order?.indexOf(kind) ?? -1) + 1;

/** Wakes the reviewers of these rows, one wake per agent however many reviews it holds. */
export async function wakeReviewers(db: Db, t: Ticket, rows: ReviewRow[], notify: Notify, skip: Array<string | null> = [], causedByRunId?: string | null) {
  const byAgent: Record<string, ReviewRow[]> = {};
  for (const r of rows) if (r.reviewerAgentId && !skip.includes(r.reviewerAgentId)) (byAgent[r.reviewerAgentId] ??= []).push(r);
  for (const [agentId, mine] of Object.entries(byAgent)) {
    const asks = mine.map((r) => `  Your ${r.kind} review, round ${r.round}: look at ${KIND_FOCUS[r.kind as ReviewSlot]}.`).join("\n");
    const how = `  Read the changes with the review tool (action diff), then give your verdict with action submit${mine.length > 1 ? " and the kind of each review" : ""}.`;
    await notify(agentId, { reason: REVIEW_REASON, priority: 3, causedByRunId, note: `- ${t.id} "${t.title}": ${t.stateNote ?? "(no note)"}\n${asks}\n${how}` });
  }
}

/**
 * A ticket entered review: opens a round with one review per required kind and returns the ones to
 * wake now. A round still open from before (nobody answered it) is dropped.
 */
export async function requestReviews(db: Db, t: Ticket): Promise<ReviewRow[]> {
  const open = await latestRows(db, t.id);
  if (open.some((r) => r.status === "pending")) await skipPending(db, open);
  const rule = ruleFor(await effectivePolicy(db, t), t.risk);
  const wanted: Array<[ReviewSlot, string]> = [["code", rule.reviewer], ...REVIEW_KINDS.flatMap((k): Array<[ReviewSlot, string]> => (rule.kinds?.[k] ? [[k, rule.kinds[k]!]] : []))];
  const round = (open[0]?.round ?? 0) + 1;
  const rows: ReviewRow[] = [];
  for (const [kind, ref] of wanted) {
    const { agent, note } = await resolveKindReviewer(db, t.companyId, kind, ref, t.assigneeAgentId);
    if (note) await record(db, { companyId: t.companyId, kind: "review_fallback", summary: note, ticketId: t.id });
    const [row] = await db.insert(reviewRequests).values({ ticketId: t.id, kind, reviewerAgentId: agent?.id ?? null, round, seq: seqOf(t.reviewOrder, kind) }).returning();
    rows.push(row!);
  }
  return activeRows(rows);
}

/** The CEO's order for a ticket's reviews: listed kinds run one after another; unlisted ones are not held back. Empty clears it. */
export async function setReviewOrder(db: Db, t: Ticket, order: string[], byAgentId: string | null): Promise<ReviewRow[]> {
  await db.update(tickets).set({ reviewOrder: order.length ? order : null }).where(eq(tickets.id, t.id));
  const rows = await latestRows(db, t.id);
  const before = new Set(activeRows(rows).map((r) => r.id));
  for (const r of rows) if (r.status === "pending") r.seq = seqOf(order, r.kind);
  for (const r of rows) if (r.status === "pending") await db.update(reviewRequests).set({ seq: r.seq }).where(eq(reviewRequests.id, r.id));
  await record(db, { companyId: t.companyId, agentId: byAgentId, ticketId: t.id, kind: "review_sequence", summary: order.length ? `Reviews run in this order: ${order.join(", then ")}` : "Reviews run all at once" });
  return activeRows(rows).filter((r) => !before.has(r.id));
}

export const decide = (db: Db, id: string, patch: Partial<Pick<ReviewRow, "status" | "notes" | "comments" | "overruledByAgentId" | "overruleReason">>) =>
  db.update(reviewRequests).set({ ...patch, decidedAt: new Date() }).where(eq(reviewRequests.id, id));

/** Reviews that never ran because an earlier one failed. */
export const skipPending = (db: Db, rows: ReviewRow[]) => db.update(reviewRequests).set({ status: "skipped" }).where(inArray(reviewRequests.id, rows.filter((r) => r.status === "pending").map((r) => r.id)));
export const reviveSkipped = (db: Db, rows: ReviewRow[]) => db.update(reviewRequests).set({ status: "pending" }).where(inArray(reviewRequests.id, rows.filter((r) => r.status === "skipped").map((r) => r.id)));

/** Every round of a ticket's reviews with reviewer names, newest round first, for the ticket page. */
export async function listReviews(db: Db, ticketId: string) {
  return db
    .select({ r: reviewRequests, reviewer: agents.name })
    .from(reviewRequests)
    .leftJoin(agents, eq(agents.id, reviewRequests.reviewerAgentId))
    .where(eq(reviewRequests.ticketId, ticketId))
    .orderBy(desc(reviewRequests.round), reviewRequests.seq, reviewRequests.kind)
    .then((rows) => rows.map(({ r, reviewer }) => ({ id: r.id, kind: r.kind, round: r.round, seq: r.seq, status: r.status, reviewer, reviewerAgentId: r.reviewerAgentId, notes: r.notes, overruleReason: r.overruleReason, decidedAt: r.decidedAt })));
}
