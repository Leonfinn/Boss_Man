// The review service's hold and go-live actions (BOS-1901, move 1 of the BOS-1886 split). Each is a review service method
// moved out whole: it takes the service as `this` (so calls to other methods go through the assembled object, where tests
// spy on them) and the shared context as `ctx`. review.ts keeps one delegate line per method.
import { and, eq, isNotNull } from "drizzle-orm";
import { criterionText, isAfterMerge, movableFailures, readCriteria, type ReviewComment } from "@boss-man/shared";
import { agents, ticketMessages, tickets } from "../db/schema.js";
import { activeRows, decide, evaluate, latestRows, reviveSkipped, wakeReviewers } from "./review-kinds.js";
import { record } from "./activity.js";
import { closeHold, openHold } from "./review-holds.js";
import { goLiveWaitOf, serverIsGoLive } from "./go-live-wait.js";
import { ReviewError, type HoldActor } from "./review-common.js";
import type { ReviewCtx } from "./review-ctx.js";
import type { ReviewSelf } from "./review.js";

/** Who may end a hold: the reviewer who set it, the CEO, or the owner (no agent). */
export async function holdActorCheck(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, by: HoldActor) {
  const { db } = ctx;
  const hold = await openHold(db, ticketId);
  if (!hold) throw new ReviewError(409, "That ticket has no hold.");
  if (by.agentId && !by.isCeo && hold.reviewerAgentId !== by.agentId) throw new ReviewError(403, "Only the reviewer who set the hold, the CEO or the owner can release or cancel it.");
  return hold;
}

/**
 * Release (BOS-808): the hold ends, the reviewer's pass stands, and the normal approve path runs next, so owner sign-off
 * and the merge gate apply exactly as for any approval.
 */
export async function releaseHold(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, by: HoldActor, o: { companyId?: string; background?: boolean; causedByRunId?: string | null } = {}) {
  const { db, ticketWithRepo } = ctx;
  const { t } = await ticketWithRepo(ticketId, o.companyId);
  const hold = await this.holdActorCheck(ticketId, by);
  if (!(await closeHold(db, hold, "released", by.name))) throw new ReviewError(409, "That hold was already ended.");
  await record(db, { companyId: t.companyId, agentId: by.agentId ?? null, ticketId, kind: "review_hold_released", summary: `${by.name} released the hold; the merge goes on.` });
  if (t.systemState !== "review") return { outcome: "released" as const, delivered: "released; the ticket is no longer in review, so there is nothing to merge" };
  const rows = await latestRows(db, ticketId);
  if (!rows.length || evaluate(rows) !== "passed") return { outcome: "released" as const, delivered: "released; the other reviews are still to come, and it merges when they pass" };
  const [r] = hold.reviewerAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, hold.reviewerAgentId)) : [];
  const res = await this.approve(t, { reviewer: r?.name ?? by.name, reviewerAgentId: hold.reviewerAgentId, background: o.background, causedByRunId: o.causedByRunId });
  return { outcome: "released" as const, delivered: res.delivered ?? null, approval: res };
}

/** Cancel (BOS-808): the pass is withdrawn (the slot goes back to pending), so the work is reviewed again. */
export async function cancelHold(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, by: HoldActor, o: { companyId?: string } = {}) {
  const { db, ticketWithRepo, state } = ctx;
  const { t } = await ticketWithRepo(ticketId, o.companyId);
  const hold = await this.holdActorCheck(ticketId, by);
  if (!(await closeHold(db, hold, "cancelled", by.name))) throw new ReviewError(409, "That hold was already ended.");
  await record(db, { companyId: t.companyId, agentId: by.agentId ?? null, ticketId, kind: "review_hold_cancelled", summary: `${by.name} cancelled the hold; the earlier pass no longer counts, so the work is reviewed again.` });
  const rows = await latestRows(db, ticketId);
  if (state.wake && t.systemState === "review") await wakeReviewers(db, t, activeRows(rows).filter((r) => r.id === hold.reviewRequestId), (id, i) => state.wake!(id, i));
  return { outcome: "cancelled" as const, delivered: "cancelled; the review is open again" };
}

/**
 * BOS-1021: for every merged ticket of the company whose after-merge checks wait for go-live, looks again at
 * what is still missing. Once the server runs the merge (and the runners have it, for runner code) the wait is
 * cleared and the assignee is woken with the live checks; until then nothing is sent. Returns how many were woken.
 */
export async function releaseGoLiveWaiters(this: ReviewSelf, ctx: ReviewCtx, companyId: string) {
  const { db, releaseGoLive } = ctx;
  const waiting = await db.select().from(tickets).where(and(eq(tickets.companyId, companyId), isNotNull(tickets.goLiveWait)));
  let woken = 0;
  for (const t of waiting) {
    const now = await goLiveWaitOf(db, t);
    if (now) {
      if (now !== t.goLiveWait) await db.update(tickets).set({ goLiveWait: now }).where(eq(tickets.id, t.id));
      continue;
    }
    if (await releaseGoLive(t, null)) woken++;
  }
  return woken;
}

/**
 * BOS-1345: the CEO of a company that puts its own work live says a merged ticket is live, with evidence (a commit
 * sha or a short note). The wait ends as at a server go-live: the assignee is woken with the after-merge checks.
 * Refused for the home company, whose go-live is the server update. The role check is the caller's (CEO only).
 */
export async function markLive(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, companyId: string, input: { evidence: string; by: string }) {
  const { db, releaseGoLive } = ctx;
  const evidence = input.evidence.replace(/\s+/g, " ").trim();
  if (!evidence) throw new ReviewError(400, "Give the evidence that it is live: the commit sha that went live, or a short note of how it went live.");
  const [t] = await db.select().from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.companyId, companyId)));
  if (!t) throw new ReviewError(404, "No ticket with that ID in your company.");
  if (!t.mergeCommit) throw new ReviewError(409, "This ticket hasn't merged, so there is nothing to mark live.");
  if (await serverIsGoLive(db, companyId)) throw new ReviewError(409, "This company's work goes live with the Boss Man server update, and Boss Man sees that itself when the server runs the merge. Nothing to mark.");
  const at = new Date();
  await db.update(tickets).set({ liveMarkedAt: at, liveEvidence: evidence, liveAt: at }).where(eq(tickets.id, t.id));
  await record(db, { companyId, ticketId: t.id, kind: "go_live_marked", summary: `${input.by} marked the merge ${t.mergeCommit.slice(0, 12)} live. Evidence: ${evidence}` });
  await db.insert(ticketMessages).values({ companyId, ticketId: t.id, author: "system", text: `${input.by} marked this ticket's merge live. Evidence: ${evidence}` });
  const woken = t.goLiveWait ? await releaseGoLive({ ...t, liveMarkedAt: at }, evidence) : false;
  return { woken, wasWaiting: !!t.goLiveWait };
}

/**
 * The owner's (or CEO's) "move these checks to after the merge" on a stuck-review card (BOS-422): the named criteria become
 * after-merge ones, the changes-requested reviews that only failed them are overruled, and the ticket goes on through review.
 * Owner sign-off still applies, as it does after an overrule.
 */
export async function moveAfterMerge(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, criteria: string[]) {
  const { db } = ctx;
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t || t.systemState === "done") return;
  // Re-check against the reviews as they are now (a stale card, or criteria edited since): every changes-requested review
  // must fail only criteria in the moved set, with no line comments; otherwise nothing is moved or overruled.
  const current = readCriteria(t.acceptanceCriteria);
  const asked = new Set(criteria);
  const open = (await latestRows(db, ticketId)).filter((r) => r.status === "changes_requested");
  const ok = open.every((r) => {
    const m = movableFailures(current, r.comments as ReviewComment[], r.notes ?? "");
    return m.length > 0 && m.every((c) => asked.has(c));
  });
  if (!ok) return this.sendBack(ticketId, open.map((r) => r.notes ?? "").join("\n\n"), "the reviewer");
  const move = new Set(criteria);
  const next =readCriteria(t.acceptanceCriteria).map((c) => (!isAfterMerge(c) && move.has(criterionText(c)) ? { text: criterionText(c), after: "merge" as const } : c));
  await db.update(tickets).set({ acceptanceCriteria: next }).where(eq(tickets.id, ticketId));
  const rows = await latestRows(db, ticketId);
  const before = activeRows(rows);
  const failed = rows.filter((r) => r.status === "changes_requested");
  for (const r of failed) await decide(db, r.id, { status: "overruled", overruleReason: `Moved to after the merge: ${criteria.map((c) => `"${c}"`).join(", ")}` });
  await record(db, { companyId: t.companyId, ticketId, kind: "review_overruled", summary: `Stuck review: ${criteria.map((c) => `"${c}"`).join(", ")} moved to after the merge, so the changes requested on them no longer hold the ticket.` });
  await reviveSkipped(db, rows);
  const reviewer = failed.find((r) => r.reviewerAgentId)?.reviewerAgentId;
  // A review the owner gave straight from the ticket page has no review rows: the move is the approval.
  if (!reviewer) return failed.length ? undefined : this.approve(t, { reviewer: "the owner", background: true });
  return this.settle(t, { verdict: "approved", reviewer: "the owner", reviewerAgentId: reviewer, before });
}
