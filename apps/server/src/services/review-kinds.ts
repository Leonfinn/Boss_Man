// Reviews by kind: when a ticket enters review, every review the tier requires (the code review plus
// any security, infra or adversarial ones) is requested at once. The CEO may order them; each
// verdict is kept; the ticket passes only when all approve or the CEO has overruled the rest.
import { and, desc, eq, inArray, isNull, like, max, ne, or } from "drizzle-orm";
import { KIND_FOCUS, REVIEW_KINDS, ruleFor, ticketRef, type ReviewSlot } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, reviewRequests, runs, tickets, wakes } from "../db/schema.js";
import { record } from "./activity.js";
import { readVerdicts } from "@boss-man/shared";
import { effectivePolicy, otherReviewers, resolveKindReviewer } from "./review-policy.js";

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
  // The ticket's criteria with the author's pass/fail, so the reviewer checks the work against them.
  const checklist = t.acceptanceCriteria.length
    ? readVerdicts(t.acceptanceCriteria, t.stateNote)
        .map((r) => `  - [${r.verdict ?? "not reported"}] ${r.criterion}`)
        .join("\n") + "\n  If one fails, request changes and say which."
    : "";
  for (const [agentId, mine] of Object.entries(byAgent)) {
    const asks = mine.map((r) => `  Your ${r.kind} review, round ${r.round}: look at ${KIND_FOCUS[r.kind as ReviewSlot]}.`).join("\n");
    const how = `  Read the changes with the review tool (action diff), then give your verdict with action submit${mine.length > 1 ? " and the kind of each review" : ""}.`;
    await notify(agentId, { reason: REVIEW_REASON, priority: 3, causedByRunId, note: `- ${t.id} "${t.title}": ${t.stateNote ?? "(no note)"}\n${asks}\n${how}${checklist ? `\nAcceptance criteria:\n${checklist}` : ""}` });
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
  const waiting = (await reviewWaits(db, [ticketId])).get(ticketId) ?? null;
  return db
    .select({ r: reviewRequests, reviewer: agents.name })
    .from(reviewRequests)
    .leftJoin(agents, eq(agents.id, reviewRequests.reviewerAgentId))
    .where(eq(reviewRequests.ticketId, ticketId))
    .orderBy(desc(reviewRequests.round), reviewRequests.seq, reviewRequests.kind)
    .then((rows) => rows.map(({ r, reviewer }) => ({ waitingOn: r.status === "pending" ? waiting : null, id: r.id, kind: r.kind, round: r.round, seq: r.seq, status: r.status, reviewer, reviewerAgentId: r.reviewerAgentId, notes: r.notes, overruleReason: r.overruleReason, createdAt: r.createdAt, decidedAt: r.decidedAt })));
}

/** Who each ticket's open reviews are waiting on and why, one short line per ticket ("Sam is busy on BOS-7"). Tickets nobody is holding up are left out. */
export async function reviewWaits(db: Db, ticketIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>(); // not state: built per call and returned
  for (const ticketId of ticketIds) {
    const lines: string[] = [];
    for (const r of activeRows(await latestRows(db, ticketId))) {
      if (!r.reviewerAgentId) continue;
      const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, r.reviewerAgentId));
      const [live] = await db
        .select({ ticketId: runs.ticketId, number: tickets.number, prefix: companies.ticketPrefix })
        .from(runs)
        .leftJoin(tickets, eq(tickets.id, runs.ticketId))
        .leftJoin(companies, eq(companies.id, runs.companyId))
        .where(and(eq(runs.agentId, r.reviewerAgentId), isNull(runs.endedAt), or(isNull(runs.purpose), ne(runs.purpose, "chat"))))
        .limit(1);
      const name = who?.name ?? "The reviewer";
      if (live?.ticketId === ticketId) lines.push(`${name} is reviewing it now`);
      else if (live) lines.push(`${name} is busy on ${ticketRef(live.prefix, live.number) ?? "another run"}`);
      else {
        const [w] = await db
          .select({ status: wakes.status, reason: wakes.statusReason })
          .from(wakes)
          .where(and(eq(wakes.agentId, r.reviewerAgentId), eq(wakes.reason, REVIEW_REASON), inArray(wakes.status, ["queued", "deferred"]), isNull(wakes.runId), like(wakes.note, `%- ${ticketId} %`)))
          .limit(1);
        if (w) lines.push(w.reason && w.status === "queued" ? `${name} is next, but is held up: ${w.reason}` : `${name} is about to start`);
      }
    }
    if (lines.length) out.set(ticketId, [...new Set(lines)].join("; "));
  }
  return out;
}

/**
 * A review wake that has waited behind a busy reviewer: each ticket it lists whose review has
 * another qualified, free reviewer moves to them (logged on the ticket) and leaves the old wake.
 * Returns the wake's remaining note, null once nothing is left on it.
 */
export async function handOverReviews(db: Db, wake: { agentId: string; note: string | null }, isBusy: (agentId: string) => boolean, notify: Notify, waitedMs: number): Promise<string | null> {
  const blocks = (wake.note ?? "").split(/^(?=- [0-9a-f-]{36} )/m).filter((b) => b.trim());
  const kept: string[] = [];
  const [from] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, wake.agentId));
  for (const block of blocks) {
    const ticketId = block.match(/^- ([0-9a-f-]{36}) /)?.[1];
    const [t] = ticketId ? await db.select().from(tickets).where(eq(tickets.id, ticketId)) : [];
    if (!t || t.systemState !== "review") {
      kept.push(block);
      continue;
    }
    const mine = activeRows(await latestRows(db, t.id)).filter((r) => r.reviewerAgentId === wake.agentId);
    const rule = ruleFor(await effectivePolicy(db, t), t.risk);
    const moved: ReviewRow[] = [];
    for (const r of mine) {
      const ref = r.kind === "code" ? rule.reviewer : rule.kinds?.[r.kind as Exclude<ReviewSlot, "code">];
      const [to] = ref ? (await otherReviewers(db, t.companyId, r.kind as ReviewSlot, ref, t.assigneeAgentId, [wake.agentId])).filter((a) => !isBusy(a.id)) : [];
      if (!to) continue;
      await db.update(reviewRequests).set({ reviewerAgentId: to.id }).where(eq(reviewRequests.id, r.id));
      await record(db, { companyId: t.companyId, agentId: wake.agentId, ticketId: t.id, kind: "review_handover", summary: `${from?.name ?? "The reviewer"} was busy for ${Math.round(waitedMs / 60_000)} minutes, so ${to.name} takes the ${r.kind} review` });
      moved.push({ ...r, reviewerAgentId: to.id });
    }
    if (moved.length) await wakeReviewers(db, t, moved, notify);
    if (moved.length < mine.length || !mine.length) kept.push(block);
  }
  return kept.length ? kept.join("") : null;
}
