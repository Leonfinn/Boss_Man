// Reviews by kind: when a ticket enters review, every review the tier requires (the code review plus
// any security, infra or adversarial ones) is requested at once. The CEO may order them; each
// verdict is kept; the ticket passes only when all approve or the CEO has overruled the rest.
import { and, desc, eq, inArray, isNull, like, max, min, ne, or, sql, type AnyColumn } from "drizzle-orm";
import { KIND_FOCUS, REVIEW_KINDS, ruleFor, slotRef, ticketRef, type ReviewerRefValue, type ReviewSlot } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, reviewRequests, runs, tickets, wakes } from "../db/schema.js";
import { record } from "./activity.js";
import { isAfterMerge, readVerdicts } from "@boss-man/shared";
import { effectivePolicy, otherReviewers, resolveKindReviewer } from "./review-policy.js";
import { endHolds } from "./review-holds.js";

export type ReviewRow = typeof reviewRequests.$inferSelect;
type Ticket = typeof tickets.$inferSelect;
export type Notify = (agentId: string, input: { reason: string; note: string; priority: number; ticketId?: string | null; causedByRunId?: string | null }) => Promise<unknown>;
export const REVIEW_REASON = "review requested";
const SETTLED = ["approved", "overruled"];

/** How the wake note names the ticket: "- <ticketId> ". The progress sweep matches on it to find a reviewer's runs (BOS-314); keep both in step by building and matching through here. */
export const reviewAskPrefix = (ticketId: string) => `- ${ticketId} `;
/** The SQL pattern matching `reviewAskPrefix` in a wake note. */
export const reviewAskPattern = (ticketId: string) => `${reviewAskPrefix(ticketId)}%`;

/**
 * True when a run ended on its own (DR-017, decision F): a run cut off by a runner restart ("interrupted")
 * or one the server gave up on ("lost: ...") never got to answer, so it is not a missed verdict for either
 * no-verdict detector. One list for both, so they can't drift apart.
 */
export function endedNormally(outcome: string | null | undefined): boolean {
  return !!outcome && outcome !== "interrupted" && !outcome.startsWith("lost:");
}

/** The SQL condition matching `endedNormally` for a run outcome column. */
export const endedNormallySql = (outcome: AnyColumn) => sql`${outcome} is not null and ${outcome} <> 'interrupted' and ${outcome} not like 'lost:%'`;

/** The rows of the ticket's newest round. */
export async function latestRows(db: Db, ticketId: string): Promise<ReviewRow[]> {
  const [m] = await db.select({ n: max(reviewRequests.round) }).from(reviewRequests).where(eq(reviewRequests.ticketId, ticketId));
  if (!m?.n) return [];
  return db.select().from(reviewRequests).where(and(eq(reviewRequests.ticketId, ticketId), eq(reviewRequests.round, m.n))).orderBy(reviewRequests.seq, reviewRequests.kind);
}

/**
 * When the ticket's current review round began (BOS-433): the moment its newest round opened. A ticket
 * that was sent back and came to review again opens a new round, so wakes and runs from the rounds
 * before it say nothing about this one. Nothing for a ticket with no reviews yet.
 */
export async function roundStartedAt(db: Db, ticketId: string): Promise<Date | null> {
  const [m] = await db.select({ n: max(reviewRequests.round) }).from(reviewRequests).where(eq(reviewRequests.ticketId, ticketId));
  if (!m?.n) return null;
  const [at] = await db.select({ at: min(reviewRequests.createdAt) }).from(reviewRequests).where(and(eq(reviewRequests.ticketId, ticketId), eq(reviewRequests.round, m.n)));
  return at?.at ?? null;
}

/** The activity kind a "Leave it another hour" answer writes (BOS-426, BOS-433 fix B). */
export const REVIEW_WAIT = "review_wait";

/**
 * Record that the CEO or owner left this review another quiet period, so the stall sweep leaves it
 * alone until then (BOS-426, BOS-433 fix B). Without it the answer only freed the card's key and the
 * next sweep raised the same card again within a minute. The review's id is on the row's detail, so
 * the sweep reads it back through {@link reviewWaitedSince}.
 */
export async function recordReviewWait(db: Db, row: { companyId: string; ticketId: string; reviewId: string; at: Date; agentId?: string | null }) {
  await record(db, { companyId: row.companyId, agentId: row.agentId ?? null, ticketId: row.ticketId, kind: REVIEW_WAIT, summary: "The review was left another hour.", detail: { reviewId: row.reviewId }, at: row.at });
}

/** When this review was last left another hour, or null if it never was. */
export async function reviewWaitedSince(db: Db, reviewId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(activity.at) })
    .from(activity)
    .where(and(eq(activity.kind, REVIEW_WAIT), sql`${activity.detail}->>'reviewId' = ${reviewId}`));
  return row?.at ?? null;
}

/** Pending reviews whose turn it is. Seq 0 is never held back and holds nobody; a numbered review waits for the lower numbers to approve or be overruled. */
export const activeRows = (rows: ReviewRow[]) => rows.filter((r) => r.status === "pending" && rows.every((o) => o.seq === 0 || o.seq >= r.seq || SETTLED.includes(o.status)));

/** waiting: someone must still review. failed: nobody can, and a change was requested. passed: all approved or overruled. */
export function evaluate(rows: ReviewRow[]): "waiting" | "failed" | "passed" {
  if (activeRows(rows).length) return "waiting";
  if (rows.some((r) => r.status === "changes_requested")) return "failed";
  return rows.every((r) => SETTLED.includes(r.status)) ? "passed" : "waiting";
}

/**
 * The tickets, of those given, whose newest review round has passed: every reviewer approved (or was
 * overruled), so all that is left is the merge or the owner's sign-off. One query for the lot. The
 * board's "Approved, merging" lane and the dashboard's count use it (BOS-667), the same test the merge
 * queue uses, so a ticket waiting on a reviewer is never counted as merging and the other way round.
 */
export async function passedReviewTickets(db: Db, ticketIds: string[]): Promise<Set<string>> {
  if (!ticketIds.length) return new Set();
  const rows = await db.select().from(reviewRequests).where(inArray(reviewRequests.ticketId, ticketIds));
  const newest = new Map<string, ReviewRow[]>(); // not state: local to passedReviewTickets
  for (const r of rows) {
    const cur = newest.get(r.ticketId);
    if (!cur || cur[0]!.round < r.round) newest.set(r.ticketId, [r]);
    else if (cur[0]!.round === r.round) cur.push(r);
  }
  return new Set([...newest].filter(([, round]) => evaluate(round) === "passed").map(([id]) => id));
}

const seqOf = (order: string[] | null | undefined, kind: string) => (order?.indexOf(kind) ?? -1) + 1;

/** The ticket ids a review wake's note lists, in the order it lists them. The list is what the reviewer was asked to cover. */
export const reviewTicketsOf = (note: string | null | undefined) => [...(note ?? "").matchAll(/^- ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) /gm)].map((m) => m[1]!);

/**
 * A review wake that listed several tickets and ended having answered only some of them (BOS-433, fix B):
 * the tickets still open with that reviewer and no verdict are queued again, one wake per ticket, so the
 * run that ends finishes the job rather than the sweep noticing an hour later. Returns the tickets re-woken.
 * The reviewer's own verdict on any of them means that one is done; the others wait for the next run.
 */
export async function requeueUnansweredReviews(db: Db, input: { reviewerAgentId: string; ticketIds: string[]; causedByRunId?: string | null }, notify: Notify): Promise<string[]> {
  const requeued: string[] = [];
  for (const ticketId of [...new Set(input.ticketIds)]) {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!t || t.systemState !== "review") continue;
    // The rows still waiting for this reviewer in the current round: a verdict (or a skip) has moved them on.
    const mine = activeRows(await latestRows(db, ticketId)).filter((r) => r.reviewerAgentId === input.reviewerAgentId);
    if (!mine.length) continue;
    for (const r of mine) {
      // The ticket is named on the wake as well as in its note, so several tickets re-queued at once stay
      // separate wakes (one per ticket) rather than merging into one.
      await notify(input.reviewerAgentId, {
        reason: REVIEW_REASON,
        priority: 3,
        ticketId: t.id,
        causedByRunId: input.causedByRunId ?? null,
        note: `${reviewAskPrefix(t.id)}"${t.title}": still waiting for your ${r.kind} review (round ${r.round}). You were woken about more than one ticket last time and this one is left.\n  Read the changes with the review tool (action diff), then give your verdict with action submit.`,
      });
    }
    requeued.push(ticketId);
  }
  return requeued;
}

/**
 * Why this review sits with a stand-in (the CEO) and not the reviewer the policy names, or null when it
 * doesn't. The reason isn't stored on the row, so the policy is resolved again for the kind; it counts
 * only while that still lands on the row's reviewer.
 */
export async function fallbackReason(db: Db, t: Ticket, r: Pick<ReviewRow, "kind" | "reviewerAgentId">): Promise<string | null> {
  const kind = r.kind as ReviewSlot;
  const rule = ruleFor(await effectivePolicy(db, t), t.risk);
  const ref = kind === "code" ? rule.reviewer : rule.kinds?.[kind];
  if (ref === undefined) return null;
  const { agent, note } = await resolveKindReviewer(db, t, kind, ref);
  return note && agent?.id === r.reviewerAgentId ? note : null;
}

/** One line per open review: its kind and who holds it, with the reason when a stand-in holds it. For the ticket read and the ticket page. */
export async function openReviewHolders(db: Db, t: Ticket): Promise<Array<{ kind: string; holder: string | null; reason: string | null }>> {
  const out: Array<{ kind: string; holder: string | null; reason: string | null }> = [];
  for (const r of activeRows(await latestRows(db, t.id))) {
    if (r.status !== "pending") continue;
    const [who] = r.reviewerAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, r.reviewerAgentId)) : [];
    out.push({ kind: r.kind, holder: who?.name ?? null, reason: await fallbackReason(db, t, r) });
  }
  return out;
}

/** The open reviews as the plain lines the ticket read shows; empty when none is open. */
export async function openReviewLines(db: Db, t: Ticket): Promise<string[]> {
  const open = await openReviewHolders(db, t);
  if (!open.length) return [];
  return ["Open reviews:", ...open.map((o) => `- ${o.kind}: held by ${o.holder ?? "the owner (no agent can take it)"}${o.reason ? ` (stand-in: ${o.reason})` : ""}`)];
}

/** Wakes the reviewers of these rows, one wake per agent however many reviews it holds. */
export async function wakeReviewers(db: Db, t: Ticket, rows: ReviewRow[], notify: Notify, skip: Array<string | null> = [], causedByRunId?: string | null) {
  const byAgent: Record<string, ReviewRow[]> = {};
  for (const r of rows) if (r.reviewerAgentId && !skip.includes(r.reviewerAgentId)) (byAgent[r.reviewerAgentId] ??= []).push(r);
  // The ticket's criteria with the author's pass/fail, so the reviewer checks the work against them.
  // An after-merge criterion can only be settled once the work is live, so it is listed apart and
  // can't fail the review (DR-024 #5).
  const after = t.acceptanceCriteria.some(isAfterMerge);
  const checklist = t.acceptanceCriteria.length
    ? readVerdicts(t.acceptanceCriteria, t.stateNote)
        .map((r, i) => `  - [${r.verdict ?? "not reported"}] ${r.criterion}${isAfterMerge(t.acceptanceCriteria[i]!) ? " (checked after merge: don't fail the review on it)" : ""}`)
        .join("\n") + `\n  If a before-merge one fails, request changes and say which.${after ? " Review can approve with the after-merge ones still unreported; the ticket keeps them open until they pass." : ""}`
    : "";
  for (const [agentId, mine] of Object.entries(byAgent)) {
    const asks = (await Promise.all(mine.map(async (r) => {
      const why = await fallbackReason(db, t, r);
      return `  Your ${r.kind} review, round ${r.round}: look at ${KIND_FOCUS[r.kind as ReviewSlot]}.${why ? `\n  You hold the ${r.kind} review as a stand-in, not as its usual reviewer: ${why}.` : ""}`;
    }))).join("\n");
    const how = `  Read the changes with the review tool (action diff), then give your verdict with action submit${mine.length > 1 ? " and the kind of each review" : ""}.`;
    await notify(agentId, { reason: REVIEW_REASON, priority: 3, causedByRunId, note: `${reviewAskPrefix(t.id)}"${t.title}": ${t.stateNote ?? "(no note)"}\n${asks}\n${how}${checklist ? `\nAcceptance criteria:\n${checklist}` : ""}` });
  }
}

/**
 * A ticket entered review: opens a round with one review per required kind and returns the ones to
 * wake now. A round still open from before (nobody answered it) is dropped.
 */
export async function requestReviews(db: Db, t: Ticket): Promise<ReviewRow[]> {
  const open = await latestRows(db, t.id);
  if (open.some((r) => r.status === "pending")) await skipPending(db, open);
  // A new round makes the old pass moot, and with it any hold that rode on it (BOS-808).
  await endHolds(db, t.id, "a new review round started");
  const rule = ruleFor(await effectivePolicy(db, t), t.risk);
  const wanted: Array<[ReviewSlot, ReviewerRefValue]> = [["code", rule.reviewer], ...REVIEW_KINDS.flatMap((k): Array<[ReviewSlot, ReviewerRefValue]> => (rule.kinds?.[k] ? [[k, rule.kinds[k]!]] : []))];
  const round = (open[0]?.round ?? 0) + 1;
  const rows: ReviewRow[] = [];
  for (const [kind, ref] of wanted) {
    const { agent, note } = await resolveKindReviewer(db, t, kind, ref);
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

export const decide = (db: Db, id: string, patch: Partial<Pick<ReviewRow, "status" | "notes" | "comments" | "overruledByAgentId" | "overruleReason" | "head" | "readHead">>) =>
  db.update(reviewRequests).set({ ...patch, decidedAt: new Date() }).where(eq(reviewRequests.id, id));

/** Reviews that never ran because an earlier one failed. */
export const skipPending = (db: Db, rows: ReviewRow[]) => db.update(reviewRequests).set({ status: "skipped" }).where(inArray(reviewRequests.id, rows.filter((r) => r.status === "pending").map((r) => r.id)));
export const reviveSkipped = (db: Db, rows: ReviewRow[]) => db.update(reviewRequests).set({ status: "pending" }).where(inArray(reviewRequests.id, rows.filter((r) => r.status === "skipped").map((r) => r.id)));

/** Every round of a ticket's reviews with reviewer names, newest round first, for the ticket page. */
export async function listReviews(db: Db, ticketId: string) {
  const waiting = (await reviewWaits(db, [ticketId])).get(ticketId) ?? null;
  const [tk] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  const latestRound = (await latestRows(db, ticketId))[0]?.round ?? 0;
  const reasons = new Map((tk ? await openReviewHolders(db, tk) : []).filter((o) => o.reason).map((o) => [o.kind, o.reason!]));
  return db
    .select({ r: reviewRequests, reviewer: agents.name })
    .from(reviewRequests)
    .leftJoin(agents, eq(agents.id, reviewRequests.reviewerAgentId))
    .where(eq(reviewRequests.ticketId, ticketId))
    .orderBy(desc(reviewRequests.round), reviewRequests.seq, reviewRequests.kind)
    .then((rows) => rows.map(({ r, reviewer }) => ({ waitingOn: r.status === "pending" ? waiting : null, standIn: r.status === "pending" && r.round === latestRound ? (reasons.get(r.kind) ?? null) : null, id: r.id, kind: r.kind, round: r.round, seq: r.seq, status: r.status, reviewer, reviewerAgentId: r.reviewerAgentId, notes: r.notes, overruleReason: r.overruleReason, createdAt: r.createdAt, decidedAt: r.decidedAt })));
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
      const ref = slotRef(rule, r.kind as ReviewSlot);
      const [to] = ref ? (await otherReviewers(db, t, r.kind as ReviewSlot, ref, [wake.agentId])).filter((a) => !isBusy(a.id)) : [];
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
