// The review service's review rounds and verdicts (BOS-1904, move 4 of the BOS-1886 split): reading a ticket's work, a
// reviewer's verdict and what follows it (settle, approve, send back), the CEO's order and overrule, the owner's sign-off
// checks, the stalled-review card's actions and the "already passed this code" helpers. Each is a review service method
// moved out whole: it takes the service as `this` (so calls to other methods go through the assembled object, where tests
// spy on them) and the shared context as `ctx`. review.ts keeps one delegate line per method.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { OWNER_STEPS_MISSING, OWNER_STEPS_OK, OWNER_STEPS_WRONG, realUseWalkthrough, type OwnerStepFlag, REAL_USE_REFUSAL, touchesInstallSurface, usabilityGated } from "@boss-man/shared";
import { formatReviewComments, REVIEW_KINDS, riskOf, ruleFor, slotRef, type MigrationsResult, type ReviewComment, type ReviewSlot, type WorkspaceDiff } from "@boss-man/shared";
import { agents, decisions, reviewRequests, runners, tickets } from "../db/schema.js";
import { openHoldingCard } from "./ticket-links.js";
import { RunnerGone } from "./runners.js";
import { effectivePolicy, otherReviewers } from "./review-policy.js";
import { activeRows, decide, evaluate, latestRows, recordReviewWait, reviveSkipped, setReviewOrder, skipPending, wakeReviewers, type ReviewRow } from "./review-kinds.js";
import { REASSIGN_REVIEW, SEND_BACK_FOR_MERGE, supersedeSignoffs, TAKE_REVIEW, WAIT_ANOTHER_HOUR, type DecisionContext } from "./decisions.js";
import { derivedSignoff, openSignoffCard, priorSignoff, raiseSignoffCard, restoreSignoffCard, type SignoffCover } from "./signoff.js";
import { LESSON_ADD, LESSON_DROP, LESSON_EDIT, LESSON_MAX, lessonsForCeo, normalizeLesson } from "./project-brief.js";
import { record } from "./activity.js";
import { lineEvent } from "./merge-line.js";
import { conflictNote } from "./merge-line-conflicts.js";
import { openHold } from "./review-holds.js";
import { ReviewError, ReviewHeldError, SignoffPendingError, when, type HoldInput } from "./review-common.js";
import type { ReviewCtx } from "./review-ctx.js";
import type { ReviewSelf } from "./review.js";

/** The ticket's changes against its base, from the runner that holds its worktree. A review diff is measured from the merge-base with the project's current default branch (BOS-694); a last-turn diff is that turn only. */
export async function diff(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, companyId?: string, range: "base" | "last_turn" = "base"): Promise<WorkspaceDiff> {
  const { db, deps, ticketWithRepo } = ctx;
  const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId, companyId);
  if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo, so there's no diff to review.");
  const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
  if (!runner) throw new ReviewError(409, "The company has no runner.");
  try {
    return await deps.runners.request<WorkspaceDiff>(runner.id, (requestId) => ({ type: "workspace.diff", requestId, projectId: t.projectId, ticketId, ...(range === "last_turn" ? { range } : { baseRef: defaultBranch }) }));
  } catch (err) {
    throw new ReviewError(409, (err as Error).message);
  }
}

/**
 * BOS-1567: remember the head a reviewer's `review diff` served, on every review they still hold open in the latest round.
 * submit() compares it with the branch as it is then, so an approval is never stamped with a head the reviewer didn't read.
 * Returns the head stored before (null when none), so the caller can tell a later page was read on another head.
 * Never throws: a failed stamp must not block a diff.
 */
export async function noteRead(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, reviewerAgentId: string | null | undefined, head: string | null | undefined): Promise<string | null> {
  const { db } = ctx;
  if (!reviewerAgentId) return null;
  try {
    const mine = (await latestRows(db, ticketId)).filter((r) => r.reviewerAgentId === reviewerAgentId && r.status === "pending");
    if (!mine.length) return null;
    const before = mine.find((r) => r.readHead)?.readHead ?? null;
    await db.update(reviewRequests).set({ readHead: head || null }).where(inArray(reviewRequests.id, mine.map((r) => r.id)));
    return before;
  } catch {
    return null;
  }
}

/**
 * Whether the ticket's new migration numbers are free (BOS-219). The review-time warning
 * (withOthers false) compares only against the default branch: a clash with another open
 * branch isn't the agent's to fix, since that branch may never merge, and advising a rename
 * against it caused renumber churn and gaps on main (DR-037). The check that counts, just
 * before the merge, uses the same comparison: once one ticket has merged, the next must not
 * be sent back because a branch it clashes with is still open, or two clashing tickets would
 * keep bouncing each other. An offline runner or an unreadable branch gives "couldn't say",
 * which never holds a ticket up.
 */
export async function migrations(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, companyId?: string, withOthers = false): Promise<MigrationsResult> {
  const { db, deps, ticketWithRepo } = ctx;
  const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId, companyId);
  if (!repoUrl || t.noCode) return { needed: null, reason: "This ticket has no code of its own to check." };
  const others = !withOthers
    ? []
    : (
        await db
          .select({ branch: tickets.branch })
          .from(tickets)
          .where(and(eq(tickets.companyId, t.companyId), eq(tickets.projectId, t.projectId), inArray(tickets.systemState, ["in_progress", "review", "blocked"]), isNotNull(tickets.branch)))
      )
        .map((o) => o.branch!)
        .filter((b) => b && b !== `bossman/${ticketId}`);
  const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
  if (!runner) return { needed: null, reason: "The company has no runner, so there was nothing to compare." };
  try {
    return await deps.runners.request<MigrationsResult>(runner.id, (requestId) => ({ type: "workspace.migrations", requestId, projectId: t.projectId, ticketId, target: defaultBranch, others }));
  } catch (err) {
    return { needed: null, reason: `I couldn't check the migration numbers: ${(err as Error).message}` };
  }
}

/**
 * True when a ticket that needs code changes has none yet: its project has a repo, it isn't
 * marked "no code", and the runner reports no commits and no changed files. If the runner
 * can't answer, this is false, so an offline runner never blocks a move to review. A ticket
 * with no branch was never worked on, so it has nothing, whatever the runner says.
 */
export async function needsChanges(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, companyId?: string): Promise<boolean> {
  const { ticketWithRepo } = ctx;
  const { t, repoUrl } = await ticketWithRepo(ticketId, companyId);
  if (!repoUrl || t.noCode) return false;
  if (!t.branch) return true;
  const d = await this.diff(ticketId, companyId).catch(() => null);
  return !!d && !d.commits.length && !d.files.length;
}

/** One file of a ticket's work, from the runner that holds its repo (R77). */
export async function readFile(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, file: string, companyId?: string): Promise<{ text: string; truncated: boolean; from: "worktree" | "branch" }> {
  const { db, deps, ticketWithRepo } = ctx;
  const { t, repoUrl } = await ticketWithRepo(ticketId, companyId);
  if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo.");
  const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
  if (!runner) throw new ReviewError(409, "The company has no runner.");
  try {
    return await deps.runners.request(runner.id, (requestId) => ({ type: "workspace.file", requestId, projectId: t.projectId, ticketId, path: file }));
  } catch (err) {
    throw new ReviewError(409, (err as Error).message);
  }
}

/**
 * Records a review. Where the ticket has required reviews (see review-kinds.ts) an agent's verdict
 * fills its own; the ticket moves only when they are all in. Changes requested go to the agent
 * as one message and move the ticket back to in progress; approval finishes it.
 */
export async function submit(
  this: ReviewSelf,
  ctx: ReviewCtx,
  ticketId: string,
  input: { verdict: "approved" | "changes_requested"; comments?: ReviewComment[]; summary?: string; /** BOS-2074: the reviewer's verdict on the owner setup steps: OWNER_STEPS_OK, or the steps that are wrong. */ ownerSteps?: typeof OWNER_STEPS_OK | OwnerStepFlag[]; /** Optional one-line lesson learned, when sending it back (R-review-lessons); the owner decides. */ lesson?: string; reviewer: string; reviewerAgentId?: string | null; /** Which of the agent's reviews, when it holds several. */ kind?: string; companyId?: string; causedByRunId?: string | null; /** Land in the background and return at once (the owner's page polls `landing`). */ background?: boolean; /** "Passed, hold merge" (BOS-808): an approval that does not merge until the hold ends. */ hold?: HoldInput },
) {
  // `reviewState`, not `state`: as in review.ts, the ctx's state keeps the name it had there.
  const { db, state: reviewState, landings, ticketWithRepo, landingStale, checkHoldInput, startHold } = ctx;
  const { t, projectName } = await ticketWithRepo(ticketId, input.companyId);
  // The owner approving over a reviewer's hold must hear that nothing merged, not get a quiet "approved" (BOS-808).
  if (!input.reviewerAgentId && input.verdict === "approved" && (await openHold(db, ticketId))) throw new ReviewHeldError();
  if (input.hold) {
    if (input.verdict !== "approved") throw new ReviewError(422, "A hold goes with an approval (verdict approved_hold).");
    await checkHoldInput(t, input.hold, input.reviewerAgentId);
  }
  // The coder doesn't review its own work (R49).
  if (input.reviewerAgentId && t.assigneeAgentId === input.reviewerAgentId) throw new ReviewError(403, "You can't review a ticket assigned to you.");
  if (t.systemState === "done") throw new ReviewError(409, "That ticket is already done.");
  if (input.lesson?.trim() && input.verdict !== "changes_requested") throw new ReviewError(422, "A lesson goes with changes requested, not with an approval.");
  if ((input.lesson?.trim().length ?? 0) > LESSON_MAX) throw new ReviewError(422, "A lesson is one line, up to 240 characters.");
  const lesson = normalizeLesson(input.lesson ?? "");
  if (input.lesson?.trim() && !lesson) throw new ReviewError(422, "A lesson is one line, up to 240 characters.");
  const rows = input.reviewerAgentId ? await latestRows(db, ticketId) : [];
  if (input.verdict === "changes_requested" && !input.comments?.length && !input.summary?.trim()) throw new ReviewError(422, "Say what needs changing: add comments or a summary.");
  // BOS-2074: a reviewer who says an owner step is wrong can't approve; a code or infra approval of a ticket with owner setup steps must give a verdict on them.
  if (input.reviewerAgentId) {
    const flagged = Array.isArray(input.ownerSteps) ? input.ownerSteps.filter((s) => s.step.trim()) : [];
    if (input.verdict === "approved") {
      if (flagged.length) throw new ReviewError(422, OWNER_STEPS_WRONG);
      if (t.ownerSetup?.trim() && input.ownerSteps !== OWNER_STEPS_OK) {
        const openKinds = rows.filter((r) => r.reviewerAgentId === input.reviewerAgentId && r.status === "pending" && (!input.kind || r.kind === input.kind)).map((r) => r.kind);
        if (!rows.length || openKinds.some((k) => k === "code" || k === "infra")) throw new ReviewError(422, OWNER_STEPS_MISSING);
      }
    } else if (flagged.length) {
      input = { ...input, summary: `${input.summary?.trim() ? `${input.summary.trim()}\n\n` : ""}Owner setup steps that are wrong or not needed:\n${flagged.map((s) => `- ${s.step.trim()}: ${s.why.trim()}`).join("\n")}` };
    }
  }
  // BOS-1571 usability gate: an agent's approval of a feature, of work with owner setup steps, or of a change to what the
  // owner installs carries a written "Real use:" walk-through. The code and infra reviews (and the CEO approving a
  // ticket with no review rows) carry it; security and adversarial keep their own focus; the owner is never asked.
  if (input.verdict === "approved" && input.reviewerAgentId && !realUseWalkthrough(input.summary)) {
    const openKinds = rows.filter((r) => r.reviewerAgentId === input.reviewerAgentId && r.status === "pending" && (!input.kind || r.kind === input.kind)).map((r) => r.kind);
    const carries = !rows.length || openKinds.some((k) => k === "code" || k === "infra");
    if (carries && (usabilityGated(t) || touchesInstallSurface(await this.diff(ticketId).then((d) => d.files.map((f) => f.path), () => [] as string[])))) throw new ReviewError(422, REAL_USE_REFUSAL);
  }
  // Each lesson becomes exactly one CEO decision (BOS-105): nothing reaches the brief without it, and the owner is told the outcome.
  if (lesson) {
    const question = `Add this lesson to ${projectName}'s brief? "${lesson}"\n\nIt came from the review of ticket "${t.title}" (${ticketId}).\n\n${await lessonsForCeo(db, t.companyId, t.projectId)}\n\nJudge whether it overlaps a lesson already there and whether it is worth a line. Answer with a one-line reason as the note.`;
    const [row] = await db
      .insert(decisions)
      .values({
        companyId: t.companyId,
        kind: "question",
        question,
        options: [LESSON_ADD, LESSON_EDIT, LESSON_DROP],
        recommendedOption: LESSON_ADD,
        tier: "ceo",
        raisedByAgentId: input.reviewerAgentId ?? null,
        dedupeKey: `lesson:${ticketId}:${lesson}`,
        context: { type: "lesson", ticketId, projectId: t.projectId, projectName, lesson },
      })
      .onConflictDoNothing()
      .returning({ id: decisions.id });
    if (row) {
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
      if (ceo) await reviewState.wake?.(ceo.id, { reason: "decision", note: `A decision is waiting for you: ${question}\nUse the decisions tool to read it and answer.` });
    }
  }
  let diffText = "";
  if (input.verdict === "changes_requested" && input.comments?.some((c) => !c.code)) diffText = await this.diff(ticketId).then((d) => d.diff, () => "");
  if (!rows.length) {
    if (input.hold) throw new ReviewError(422, "You have no review on this ticket to hold the merge from.");
    if (input.verdict === "approved") return this.approve(t, { reviewer: input.reviewer, reviewerAgentId: input.reviewerAgentId, background: input.background, causedByRunId: input.causedByRunId });
    // The owner sending it back ends any reviews still open.
    if (!input.reviewerAgentId) await skipPending(db, await latestRows(db, ticketId));
    return this.sendBackRound(t, { reviewer: input.reviewer, comments: input.comments ?? [], text: formatReviewComments(input.reviewer, input.comments ?? [], diffText, input.summary), causedByRunId: input.causedByRunId });
  }

  // An agent's verdict fills one of the ticket's required reviews.
  const mine = rows.filter((r) => r.reviewerAgentId === input.reviewerAgentId && r.status === "pending" && (!input.kind || r.kind === input.kind));
  // Every review is already in (approved or overruled) but the merge never ran: nothing is left to fill, so say so,
  // and let an approval from a reviewer who held a slot start the merge instead of refusing it ("no open review").
  if (!mine.length && t.systemState === "review" && evaluate(rows) === "passed" && rows.some((r) => r.reviewerAgentId === input.reviewerAgentId)) {
    if (input.verdict !== "approved") throw new ReviewError(409, "Every review on this ticket is already in and approved; it is waiting to merge. Ask the CEO if it should go back to the agent.");
    // A reviewer who already passed it can still ask for the merge to wait (BOS-808): the pass stands.
    if (input.hold) {
      const mineApproved = rows.filter((r) => r.reviewerAgentId === input.reviewerAgentId && r.status === "approved").at(-1)!;
      await startHold(t, mineApproved, input.hold, input.reviewer);
      return { verdict: "approved" as const, outcome: "held" as const, delivered: `the pass stands; the merge is held: ${input.hold.reason.trim()}` };
    }
    if (await openHold(db, ticketId)) return { verdict: "approved" as const, outcome: "held" as const, delivered: "the merge is held by a reviewer; it goes on once the hold is released" };
    // The same holding rule as the gate (BOS-1078): a plain question on the ticket doesn't stop this merge.
    const holding = (await openSignoffCard(db, ticketId)) ?? (await openHoldingCard(db, ticketId));
    if (holding || (await derivedSignoff(db, t)).state === "waiting") throw new ReviewError(409, `Every review is in; the ticket is waiting on the owner's decision${holding ? ` (card ${holding})` : ""} before it merges.`);
    if (landings.get(ticketId)?.state === "running" && !(await landingStale(ticketId))) throw new ReviewError(409, "Every review is in and the merge is running now.");
    await record(db, { companyId: t.companyId, agentId: input.reviewerAgentId ?? null, ticketId, kind: "merge_restarted", summary: `All reviews were in but the merge had not run; ${input.reviewer} confirmed the approval, so Boss Man started it.` });
    return this.approve(t, { reviewer: input.reviewer, reviewerAgentId: input.reviewerAgentId, background: input.background, causedByRunId: input.causedByRunId });
  }
  if (!mine.length) throw new ReviewError(rows.some((r) => r.reviewerAgentId === input.reviewerAgentId) ? 409 : 403, "You have no open review on this ticket. The CEO can overrule a review that asked for changes.");
  const active = activeRows(rows);
  const ready = mine.filter((r) => active.some((a) => a.id === r.id));
  if (!ready.length) throw new ReviewError(409, `Not yet: your ${mine[0]!.kind} review waits for an earlier review to finish first. You'll be woken when it's your turn.`);
  if (ready.length > 1) throw new ReviewError(422, `You hold more than one review here (${ready.map((r) => r.kind).join(", ")}); say which with kind.`);
  const row = ready[0]!;
  const who = row.kind === "code" ? input.reviewer : `${input.reviewer}, ${row.kind} review`;
  if (input.verdict === "approved") {
    // BOS-1528: stamp the head this reviewer approved on their own row, now, not whatever the branch is at when the last
    // review of the round comes in. A runner that can't say leaves the row unstamped (it never blocks a review).
    const nowHead = await this.diff(ticketId).then((x) => x.head || null, () => null);
    // BOS-1567: stamp the head the reviewer READ (their last `review diff`). If the branch moved since, only clean merges of
    // main (signoffCovers) may have come in; any other move refuses the approval, and the reviewer reads again. No diff read
    // (null), or a runner that can't say now: the submit-time head, as before.
    let approvedHead = nowHead;
    if (row.readHead && nowHead && row.readHead !== nowHead) {
      const covered = (await this.signoffCovers(ticketId, row.readHead, nowHead).catch(() => null))?.covers === true;
      if (!covered) {
        // readHead stays: a retry without a fresh `review diff` is refused again (only a new diff replaces it).
        throw new ReviewError(409, `The branch moved since you read it (you read ${row.readHead.slice(0, 8)}, it is now ${nowHead.slice(0, 8)}). Read the diff again, then submit.`);
      }
      // Covered: the verdict on readHead carries over to nowHead. Stamping the older head would make it settle()'s
      // "newest" and reopen reviewers already approved on the newer head.
      approvedHead = nowHead;
    }
    await decide(db, row.id, { status: "approved", notes: input.summary?.trim() || null, head: approvedHead, readHead: approvedHead });
    // "Passed, hold merge": the pass stands, and every path into a merge now waits for the hold to end (BOS-808).
    if (input.hold) await startHold(t, row, input.hold, who);
  } else {
    // BOS-1958: keep the head this verdict was given on, so a later move to review can tell whether the code changed since.
    const askedHead = await this.diff(ticketId).then((x) => x.head || null, () => null);
    await decide(db, row.id, { status: "changes_requested", notes: formatReviewComments(who, input.comments ?? [], diffText, input.summary), comments: input.comments ?? [], head: askedHead });
  }
  return this.settle(t, { verdict: input.verdict, reviewer: input.reviewer, reviewerAgentId: input.reviewerAgentId!, background: input.background, causedByRunId: input.causedByRunId, before: active });
}

/** After a verdict, an overrule or a new order: wake who is next, send the work back, or approve it. */
export async function settle(this: ReviewSelf, ctx: ReviewCtx, t: typeof tickets.$inferSelect, o: { verdict: "approved" | "changes_requested"; reviewer: string; reviewerAgentId: string; background?: boolean; causedByRunId?: string | null; before: ReviewRow[] }) {
  const { db, state: reviewState } = ctx;
  const rows = await latestRows(db, t.id);
  const state = evaluate(rows);
  if (state === "waiting") {
    const was = new Set(o.before.map((r) => r.id));
    if (reviewState.wake) await wakeReviewers(db, t, activeRows(rows).filter((r) => !was.has(r.id)), (id, i) => reviewState.wake!(id, i), [], o.causedByRunId);
    return { verdict: o.verdict, outcome: "waiting" as const, delivered: `recorded; waiting for the other reviews (${activeRows(rows).map((r) => r.kind).join(", ")})` };
  }
  if (state === "passed") {
    // BOS-1528: every approval must be on the same code. An earlier reviewer whose head differs from the newest approval's
    // reads again, unless only clean merges of main came in since (signoffCovers). Unstamped rows can't be compared.
    const stamped = rows.filter((r) => r.status === "approved" && r.head).sort((a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0));
    const newest = stamped.at(-1)?.head;
    if (newest) {
      const stale: ReviewRow[] = [];
      for (const r of stamped) {
        if (r.head === newest) continue;
        if (!(await this.signoffCovers(t.id, r.head!, newest).catch(() => null))?.covers) stale.push(r);
      }
      // Covered rows only saw clean merges of main since: restamp them to the newest head, so the round has one passed
      // head (passedHead and the merge pin would otherwise see mixed heads and send the ticket back at merge).
      if (!stale.length) for (const r of stamped) if (r.head !== newest) await db.update(reviewRequests).set({ head: newest }).where(eq(reviewRequests.id, r.id));
      if (stale.length) {
        for (const r of stale) await db.update(reviewRequests).set({ status: "pending", head: null, readHead: null, decidedAt: null, notes: null }).where(eq(reviewRequests.id, r.id));
        await record(db, { companyId: t.companyId, ticketId: t.id, kind: "review_reopened", summary: `The branch moved from ${stale.map((r) => r.head!.slice(0, 8)).join(", ")} to ${newest.slice(0, 8)} while the round was open, so ${stale.map((r) => (r.kind === "code" ? "the code" : `the ${r.kind}`)).join(" and ")} review${stale.length > 1 ? "s were" : " was"} reopened to read the newer code.` });
        const reopened = await latestRows(db, t.id);
        if (reviewState.wake) await wakeReviewers(db, t, activeRows(reopened).filter((r) => stale.some((s) => s.id === r.id)), (id, i) => reviewState.wake!(id, i), [], o.causedByRunId);
        return { verdict: o.verdict, outcome: "waiting" as const, delivered: `recorded; the branch moved since an earlier approval, so ${stale.length} review${stale.length > 1 ? "s were" : " was"} reopened` };
      }
    }
    const names = [...new Set(rows.filter((r) => r.status === "approved").map((r) => r.reviewerAgentId))];
    const label = names.length > 1 ? (await db.select({ name: agents.name }).from(agents).where(inArray(agents.id, names.filter((n): n is string => !!n)))).map((a) => a.name).join(" and ") : o.reviewer;
    return await this.approve(t, { reviewer: label, reviewerAgentId: o.reviewerAgentId, background: o.background, causedByRunId: o.causedByRunId });
  }
  await skipPending(db, rows);
  const failed = rows.filter((r) => r.status === "changes_requested");
  const text = failed.map((r) => r.notes).join("\n\n");
  const sent = await this.sendBackRound(t, { reviewer: failed.map((r) => (r.kind === "code" ? "the reviewer" : `the ${r.kind} reviewer`)).join(" and "), comments: failed.flatMap((r) => r.comments as ReviewComment[]), text, parts: failed.map((r) => ({ notes: r.notes ?? "", comments: r.comments as ReviewComment[] })), causedByRunId: o.causedByRunId });
  return sent;
}

/** Approval is final unless the owner signs off (R48); then it asks them. The CEO cannot stand in for that. */
export async function approve(this: ReviewSelf, ctx: ReviewCtx, t: typeof tickets.$inferSelect, o: { reviewer: string; reviewerAgentId?: string | null; background?: boolean; causedByRunId?: string | null }) {
  const { db, deps } = ctx;
  const ticketId = t.id;
  // A reviewer's hold (BOS-808): the pass stands but nothing lands, asks the owner or starts a check until it is released.
  if (await openHold(db, ticketId)) return { verdict: "approved" as const, outcome: "held" as const, delivered: "passed; the merge is held by a reviewer and goes on once the hold is released" };
  await deps.loops.approved(ticketId, o.reviewer);
  await lineEvent(db, t, { event: "approved", by: o.reviewer, reviewerAgentId: o.reviewerAgentId ?? null });
  // The head this round passed on (BOS-1173): a return to review on the same code keeps the round (keptRound).
  // The owner signs off a commit, not a ticket (DR-013). A runner that can't say the head never reuses a sign-off.
  let files: number | undefined;
  const head = await this.diff(ticketId).then(async (x) => {
    files = x.files.length;
    // Keep the files where the plan-overlap warning can read them without a runner call (BOS-1411). Never fails a review.
    if (x.files.length) await db.update(tickets).set({ diffFiles: x.files.map((f) => f.path).slice(0, 2000) }).where(eq(tickets.id, ticketId)).catch(() => undefined);
    return x.head || null;
  }, () => null);
  // BOS-1528: approvals are stamped by submit() with the head each reviewer approved; this read is for the sign-off card only.
  // Where the review policy says the owner signs off, an agent's approval asks them (R48).
  if (o.reviewerAgentId && ruleFor(await effectivePolicy(db, t), t.risk).ownerSignoff) {
    // One open sign-off card per ticket: this round replaces any older one (BOS-446).
    const prior = await priorSignoff(db, t, head);
    // A standing sign-off on an earlier commit also counts when only clean main merges came in since (BOS-734).
    if (!prior.reuse && head && prior.current && prior.current.head !== head && (await this.signoffCovers(ticketId, prior.current.head, head))?.covers) {
      prior.reuse = prior.current;
      await record(db, { companyId: t.companyId, agentId: o.reviewerAgentId, ticketId, kind: "signoff_carried", summary: `The owner's sign-off on ${prior.current.head.slice(0, 8)} still covers ${head.slice(0, 8)}: since then main was only merged in automatically, with no clashes and no new code from the ticket.` });
    }
    if (prior.reuse) {
      await record(db, { companyId: t.companyId, agentId: o.reviewerAgentId, ticketId, kind: "signoff_reused", summary: `The owner's sign-off from ${when(prior.reuse.at)} was reused: ${o.reviewer} approved the same commit ${head!.slice(0, 8)}, so it merges without asking again.` });
      return this.landApproved(ticketId, o);
    }
    // A real conflict with a branch ahead in the merge line doesn't hold the card (BOS-1411): it adds a line
    // saying a sign-off now will likely need signing again. A read-only probe; nothing is linked.
    const conflicts = await this.mergeLineClashes(ticketId);
    const conflictsBecause = conflicts.length ? conflictNote(conflicts) : undefined;
    const id = await raiseSignoffCard(db, t, { reviewer: o.reviewer, reviewerAgentId: o.reviewerAgentId, head, earlier: prior.earlier, files, ...(conflictsBecause ? { conflictsBecause } : {}) });
    await lineEvent(db, t, { event: "hold_started", hold: "sign_off", decisionId: id ?? null });
    return { verdict: "approved" as const, outcome: "owner_review" as const, delivered: `the owner reviews ${riskOf(t.risk)}-risk work; decision ${id}` };
  }
  return this.landApproved(ticketId, o);
}

/** The merge an approval starts. A merge that waits on another ticket (BOS-1173) is a normal outcome for the approver: held, not an error. */
export async function landApproved(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, o: { reviewer: string; background?: boolean; causedByRunId?: string | null }) {
  const { db } = ctx;
  try {
    if (o.background) return { verdict: "approved" as const, outcome: "landing" as const, delivered: null, landing: await this.startLanding(ticketId, o.reviewer, o.causedByRunId) };
    return { verdict: "approved" as const, ...(await this.landVisible(ticketId, o.reviewer, o.causedByRunId)) };
  } catch (err) {
    const h = err instanceof ReviewHeldError ? await openHold(db, ticketId) : null;
    if (h && !h.reviewerAgentId) return { verdict: "approved" as const, outcome: "held" as const, delivered: (err as Error).message };
    throw err;
  }
}

/** Changes requested: a review that keeps coming back goes to the owner instead of another round (R49). */
export async function sendBackRound(this: ReviewSelf, ctx: ReviewCtx, t: typeof tickets.$inferSelect, o: { reviewer: string; comments: ReviewComment[]; text: string; parts?: { notes: string; comments: ReviewComment[] }[]; causedByRunId?: string | null }) {
  const { deps } = ctx;
  const round = await deps.loops.reviewRound({ ticketId: t.id, reviewer: o.reviewer, comments: o.comments, message: o.text, parts: o.parts });
  if (round.escalated) return { verdict: "changes_requested" as const, outcome: "escalated" as const, delivered: `held: the review looks stuck, so the CEO (or the owner, if the CEO can't settle it) decides what happens next (decision ${round.escalated})`, message: o.text, round: round.round };
  const delivered = await this.sendBack(t.id, o.text, o.reviewer, o.causedByRunId);
  return { verdict: "changes_requested" as const, outcome: "sent_back" as const, delivered, message: o.text, round: round.round };
}

/**
 * BOS-1958: the author moved a ticket that is still in review back to review. Each reviewer in the open round who asked for
 * changes is asked again when the branch head differs from the one their verdict was given on (a verdict with no recorded
 * head counts as changed). Approved reviews are left alone. Returns the reviewers' names.
 */
export async function reAskChangesRequested(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, companyId: string, causedByRunId?: string | null): Promise<string[]> {
  const { db, state: reviewState, ticketWithRepo } = ctx;
  const { t } = await ticketWithRepo(ticketId, companyId);
  if (t.systemState !== "review") return [];
  const rows = await latestRows(db, ticketId);
  const asked = rows.filter((r) => r.status === "changes_requested" && r.reviewerAgentId);
  if (!asked.length) return [];
  const head = await this.diff(ticketId).then((x) => x.head || null, () => null);
  const again = asked.filter((r) => !r.head || !head || r.head !== head);
  if (!again.length) return [];
  for (const r of again) await db.update(reviewRequests).set({ status: "pending", head: null, readHead: null, decidedAt: null, notes: null, comments: [] }).where(eq(reviewRequests.id, r.id));
  const names = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, again.map((r) => r.reviewerAgentId!)));
  await record(db, { companyId: t.companyId, ticketId, kind: "review_reopened", summary: `The author moved the ticket to review again, so ${names.map((n) => n.name).join(" and ")} ${names.length > 1 ? "are" : "is"} asked to look again.` });
  const reopened = await latestRows(db, ticketId);
  if (reviewState.wake) await wakeReviewers(db, t, activeRows(reopened).filter((r) => again.some((a) => a.id === r.id)), (id, i) => reviewState.wake!(id, i), [], causedByRunId);
  return names.map((n) => n.name);
}

/** The CEO sets the order of a ticket's reviews, for when one depends on another. */
export async function sequence(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, order: string[], byAgentId: string, companyId: string) {
  const { db, state: reviewState, ticketWithRepo } = ctx;
  const { t } = await ticketWithRepo(ticketId, companyId);
  const woken = await setReviewOrder(db, t, order, byAgentId);
  if (reviewState.wake) await wakeReviewers(db, t, woken, (id, i) => reviewState.wake!(id, i));
  return woken.length;
}

/** The CEO overrules a "changes requested", with a reason kept on the ticket. Owner sign-off still applies. */
export async function overrule(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, input: { kind: string; reason: string; byAgentId: string; companyId: string; causedByRunId?: string | null; background?: boolean }) {
  const { db, deps, ticketWithRepo } = ctx;
  const { t } = await ticketWithRepo(ticketId, input.companyId);
  if (t.systemState === "done") throw new ReviewError(409, "That ticket is already done.");
  if (t.systemState === "blocked") throw new ReviewError(409, "That ticket is waiting on a decision from the owner.");
  const rows = await latestRows(db, ticketId);
  const row = rows.find((r) => r.kind === input.kind && r.status === "changes_requested");
  if (!row) throw new ReviewError(409, `There's no ${input.kind} review asking for changes on that ticket.`);
  if (!input.reason.trim()) throw new ReviewError(422, "Give the reason you're overruling it.");
  const before = activeRows(rows);
  await decide(db, row.id, { status: "overruled", overruledByAgentId: input.byAgentId, overruleReason: input.reason.trim() });
  await record(db, { companyId: t.companyId, agentId: input.byAgentId, ticketId, kind: "review_overruled", summary: `The CEO overruled the ${input.kind} review's changes requested: ${input.reason.trim()}` });
  await reviveSkipped(db, rows);
  const after = await latestRows(db, ticketId);
  // Reviews that never ran now have to: the ticket goes back into review for them.
  if (evaluate(after) === "waiting" && t.systemState !== "review") await deps.work.updateTicket(ticketId, { state: "review", overLimit: true });
  return this.settle(t, { verdict: "approved", reviewer: "the CEO", reviewerAgentId: input.byAgentId, background: input.background, causedByRunId: input.causedByRunId, before });
}

/**
 * Whether the owner's sign-off on `signed` still covers the branch head: only clean automatic merges of the
 * default branch came in since (BOS-734, DR-038). The runner works it out from git; null when it can't say,
 * which every caller reads as "does not cover".
 */
export async function signoffCovers(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, signed: string, head?: string): Promise<SignoffCover | null> {
  const { db, deps, ticketWithRepo } = ctx;
  try {
    const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
    if (!repoUrl || !t.branch) return null;
    const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
    if (!runner || !deps.runners.isConnected(runner.id) || !deps.runners.can(runner.id, "signoff-covers")) return null;
    const r = await deps.runners.request<Partial<SignoffCover>>(runner.id, (requestId) => ({ type: "workspace.covers", requestId, projectId: t.projectId, ticketId: t.id, target: defaultBranch, signed, ...(head && /^[0-9a-f]{7,64}$/.test(head) ? { head } : {}) }), 20_000);
    if (typeof r?.covers !== "boolean") return null;
    return { covers: r.covers, reason: r.reason ?? "", newCommits: r.newCommits ?? 0, handMerges: r.handMerges ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Before an owner's "Approve and merge" press: null when the card's commit still stands (it is the branch head,
 * or only clean main merges came in), otherwise the plain reason it can't, after replacing the card with one for
 * the current head. The owner is never left holding a card that is bound to fail (BOS-734).
 */
export async function signoffStale(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, cardHead: string): Promise<string | null> {
  const head = await this.diff(ticketId).then((x) => x.head || null, () => null);
  if (!head || head === cardHead) return null;
  const c = await this.signoffCovers(ticketId, cardHead, head);
  if (c?.covers) return null;
  // The runner couldn't say: keep the card, refuse the press, nothing is replaced or merged.
  if (!c) return `The branch changed after this card was raised (${cardHead.slice(0, 8)} is now ${head.slice(0, 8)}) and Boss Man couldn't check what came in right now, so nothing was merged. Try again in a few minutes.`;
  // New code of the ticket's own: the reviewers haven't seen it, so no new card until they pass it again (security review, BOS-734).
  return this.withdrawStaleSignoff(ticketId, cardHead, head, c.reason || "new code came in");
}

/** Withdraws a sign-off card for older code and sends the ticket back for a new review round; the next round raises the new card. */
export async function withdrawStaleSignoff(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, cardHead: string, head: string, why: string): Promise<string> {
  const { db, ticketWithRepo } = ctx;
  const { t } = await ticketWithRepo(ticketId);
  await supersedeSignoffs(db, t.id, { by: "system", note: `The branch changed after the card was raised (${why}).`, at: new Date().toISOString() });
  await record(db, { companyId: t.companyId, ticketId: t.id, kind: "signoff_card_moved", summary: `The sign-off card was for ${cardHead.slice(0, 8)} but the branch is at ${head.slice(0, 8)} (${why}), so it was withdrawn and the ticket sent back for a new review.` });
  await this.sendBack(t.id, `The owner's sign-off card was for ${cardHead.slice(0, 8)}, but the branch is now at ${head.slice(0, 8)} (${why}). The card was withdrawn. Make sure the work is committed, then move the ticket back to review for a new review round and sign-off.`, "Boss Man");
  return `The branch changed after this card was raised (${why}), so it can't be merged as it stands. The card was withdrawn and the ticket sent back for a new review; a new card comes once the reviewers have passed the current code.`;
}

/** Moves the ticket back to in progress and gives the agent the review. */
export async function sendBack(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, text: string, reviewer: string, causedByRunId?: string | null) {
  const { deps, ticketWithRepo, tellAgent } = ctx;
  const { t } = await ticketWithRepo(ticketId);
  await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
  return tellAgent({ ...t, systemState: "in_progress" }, text, "review", causedByRunId);
}

/**
 * A stalled-review card's action (BOS-404, BOS-426, BOS-433 fix B): the review the card names is still
 * open, so do what the CEO or owner chose and record it on the ticket. Returns false when the review
 * has moved on (a verdict landed, the round changed, the ticket left review), so the card can be kept open.
 */
export async function reviewStall(this: ReviewSelf, rctx: ReviewCtx, ctx: Extract<DecisionContext, { type: "review_stall" }>, answer: string, byAgentId: string | null): Promise<boolean> {
  // The shared context is `rctx` here, not `ctx`: the card's own context keeps the name `ctx` it had in review.ts.
  const { db, state: reviewState } = rctx;
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ctx.ticketId));
  if (!t || t.systemState !== "review") return false;
  const [r] = await db.select().from(reviewRequests).where(and(eq(reviewRequests.id, ctx.reviewId), eq(reviewRequests.ticketId, t.id)));
  if (!r || r.status !== "pending") return false;
  const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, ctx.reviewerAgentId));
  const [by] = byAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, byAgentId)) : [];
  const actor = by?.name ?? "The owner";
  if (answer === TAKE_REVIEW) {
    // The CEO who took it is the reviewer now; a verdict from them is their own call.
    if (!byAgentId) return false;
    await db.update(reviewRequests).set({ reviewerAgentId: byAgentId }).where(eq(reviewRequests.id, r.id));
    await record(db, { companyId: t.companyId, agentId: byAgentId, ticketId: t.id, kind: "review_handover", summary: `${actor} took the ${r.kind} review from ${who?.name ?? "the reviewer"}.` });
    if (reviewState.wake) await wakeReviewers(db, t, [{ ...r, reviewerAgentId: byAgentId }], (id, i) => reviewState.wake!(id, i));
    return true;
  }
  if (answer === REASSIGN_REVIEW) {
    const rule = ruleFor(await effectivePolicy(db, t), t.risk);
    const ref = slotRef(rule, r.kind as ReviewSlot);
    const [to] = ref ? (await otherReviewers(db, t, r.kind as ReviewSlot, ref, [r.reviewerAgentId ?? ""])).filter((a) => a.id !== byAgentId) : [];
    if (!to) throw new ReviewError(409, "No other qualified reviewer is free to take it. Take it yourself, send it back to the author, or leave it another hour.");
    await db.update(reviewRequests).set({ reviewerAgentId: to.id }).where(eq(reviewRequests.id, r.id));
    await record(db, { companyId: t.companyId, agentId: byAgentId, ticketId: t.id, kind: "review_handover", summary: `${actor} gave the ${r.kind} review to ${to.name}, from ${who?.name ?? "the reviewer"}.` });
    if (reviewState.wake) await wakeReviewers(db, t, [{ ...r, reviewerAgentId: to.id }], (id, i) => reviewState.wake!(id, i));
    return true;
  }
  if (answer === SEND_BACK_FOR_MERGE) {
    await skipPending(db, [r]);
    await record(db, { companyId: t.companyId, agentId: byAgentId, ticketId: t.id, kind: "review_stall", summary: `${actor} sent the ticket back: ${who?.name ?? "the reviewer"} never gave the ${r.kind} review.` });
    await this.sendBack(t.id, `${actor} sent this back because the ${r.kind} review never got a verdict. Check the branch still merges cleanly with the default branch (a stale branch can block a reviewer), bring it up to date, then move the ticket back to review.`, actor);
    return true;
  }
  if (answer === WAIT_ANOTHER_HOUR) {
    // Nothing now, but the sweep must know it was left: it skips this review until the quiet time has
    // passed again, so the same card isn't raised within a minute (BOS-426, BOS-433 fix B). Both the
    // ticket's own line and the marker the sweep reads are written here.
    await record(db, { companyId: t.companyId, agentId: byAgentId, ticketId: t.id, kind: "review_stall", summary: `${actor} left the ${r.kind} review another hour with ${who?.name ?? "the reviewer"}.` });
    await recordReviewWait(db, { companyId: t.companyId, ticketId: t.id, reviewId: r.id, at: new Date(), agentId: byAgentId });
    return true;
  }
  return false;
}

/**
 * The head a passed round approved (BOS-1173): the one head its approvals were stamped with, or, for a round from
 * before heads were kept, the owner's standing sign-off on it when that came after the round. Null when unknown.
 */
export async function passedHead(this: ReviewSelf, ctx: ReviewCtx, t: typeof tickets.$inferSelect, rows: ReviewRow[]): Promise<string | null> {
  const { db } = ctx;
  const approved = rows.filter((r) => r.status === "approved");
  const heads = [...new Set(approved.map((r) => r.head).filter((h): h is string => !!h))];
  if (heads.length === 1 && approved.every((r) => r.head)) return heads[0]!;
  if (heads.length) return null;
  const since = Math.max(...rows.map((r) => (r.decidedAt ?? r.createdAt).getTime()));
  const prior = await priorSignoff(db, t, null);
  return prior.current?.head && new Date(prior.current.at).getTime() >= since ? prior.current.head : null;
}

/**
 * Whether a round already passed this branch head as it is now (BOS-1173): the same commit, or one that only took
 * clean merges of main since (DR-038). Null when it can't be told (no passed head, the runner didn't answer).
 */
export async function passedThisHead(this: ReviewSelf, ctx: ReviewCtx, t: typeof tickets.$inferSelect, rows: ReviewRow[]): Promise<{ head: string; how: string } | null> {
  const { db } = ctx;
  if (!rows.length || evaluate(rows) !== "passed") return null;
  // Every kind the ticket's risk asks for now must be among the passes: a risk raised since needs its new review.
  const rule = ruleFor(await effectivePolicy(db, t), t.risk);
  const wanted = ["code", ...REVIEW_KINDS.filter((k) => rule.kinds?.[k])];
  if (wanted.some((k) => !rows.some((r) => r.kind === k && (r.status === "approved" || r.status === "overruled")))) return null;
  const passed = await this.passedHead(t, rows);
  if (!passed) return null;
  const head = await this.diff(t.id).then((d) => d.head || null, () => null);
  if (!head) return null;
  if (head === passed) return { head, how: "the same commit" };
  const c = await this.signoffCovers(t.id, passed, head);
  return c?.covers ? { head, how: `${passed.slice(0, 8)} with only clean merges of main since` } : null;
}

/**
 * A ticket moved into review (BOS-1173, DR-053 point 6): true when its last round already passed this exact code,
 * so that round's approvals and the owner's sign-off stand and no new round is opened. The merge then goes on as
 * for any approved ticket (held if it waits on a fix). False opens a new round, as before, whenever anything is
 * unknown or changed.
 */
export async function keptRound(this: ReviewSelf, ctx: ReviewCtx, ticketId: string): Promise<boolean> {
  const { db, approvedAndWaiting } = ctx;
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t || t.systemState !== "review") return false;
  const rows = await latestRows(db, ticketId);
  const same = await this.passedThisHead(t, rows);
  if (!same) return false;
  await record(db, { companyId: t.companyId, ticketId, kind: "review_kept", summary: `Back in review on ${same.head.slice(0, 8)}, which round ${rows[0]!.round} already passed (${same.how}), so those approvals and any sign-off stand and no new review round was opened.` });
  if (await approvedAndWaiting(ticketId)) await this.startLanding(ticketId, "Boss Man (back in review on code its reviews already passed)").catch(() => undefined);
  return true;
}

/**
 * A round opened on code an earlier round already passed, with no verdict in it yet (BOS-1173): it is withdrawn, so
 * nobody reviews the same code again, and the merge goes on from the earlier pass. Rounds with any verdict are left
 * to finish. Each ticket's round is judged once per server run (`judged`), so a changed head isn't asked about again.
 */
export async function withdrawRepeatRounds(this: ReviewSelf, ctx: ReviewCtx, judged: Set<string>): Promise<string[]> {
  const { db, deps, approvedAndWaiting } = ctx;
  if (deps.isLeader && !deps.isLeader()) return [];
  const inReview = await db.select().from(tickets).where(eq(tickets.systemState, "review"));
  const out: string[] = [];
  for (const t of inReview) {
    const rows = await latestRows(db, t.id);
    const round = rows[0]?.round ?? 0;
    if (round < 2 || rows.some((r) => r.status !== "pending") || judged.has(`${t.id}:${round}`)) continue;
    judged.add(`${t.id}:${round}`);
    const before = await db.select().from(reviewRequests).where(and(eq(reviewRequests.ticketId, t.id), eq(reviewRequests.round, round - 1)));
    const same = await this.passedThisHead(t, before);
    if (!same) continue;
    const gone = await db.delete(reviewRequests).where(and(eq(reviewRequests.ticketId, t.id), eq(reviewRequests.round, round), eq(reviewRequests.status, "pending"))).returning({ id: reviewRequests.id });
    if (!gone.length) continue;
    await record(db, { companyId: t.companyId, ticketId: t.id, kind: "review_kept", summary: `Review round ${round} was withdrawn before anyone gave a verdict: the branch is still at ${same.head.slice(0, 8)}, which round ${round - 1} passed (${same.how}). Those approvals and any sign-off stand.` });
    out.push(t.id);
    if (await approvedAndWaiting(t.id)) await this.startLanding(t.id, "Boss Man (a repeat review round on unchanged code was withdrawn)").catch(() => undefined);
  }
  return out;
}

/**
 * Refuses a merge the owner hasn't signed off when the policy needs it (BOS-503, DR-021). `head` null: any
 * recorded sign-off for this round will do (the early check); a string: the sign-off must cover that commit,
 * and "" (the runner couldn't say) passes only an owner's own approval, which covers what is there now.
 */
export async function requireSignoff(this: ReviewSelf, ctx: ReviewCtx, t: typeof tickets.$inferSelect, head: string | null, because?: string) {
  const { db } = ctx;
  const d = await derivedSignoff(db, t, head || null);
  if (d.state === "not_needed") return;
  if (d.state === "signed_off" && (head === null || head === "" || d.head === null || d.head === head)) {
    // No commit was read (the runner was away or its diff failed): a failed prep, never a different commit.
    // land() asks again like for a runner that went away; the sign-off is not in question (BOS-1396).
    if (head === "" && d.head !== null) throw new RunnerGone("The runner didn't say which commit would merge.");
    return;
  }
  if (d.state === "waiting" && head) {
    // Signed off for another commit, with no new review since: the code changed under the sign-off, and nobody
    // reviewed what would merge now. Refuse in plain sight (the merge card that follows lets the owner send it back).
    const was = await derivedSignoff(db, t, null);
    if (was.state === "signed_off" && was.head && was.head !== head) {
      // Only clean automatic merges of the default branch since: the sign-off still covers it (BOS-734, DR-038).
      const c = await this.signoffCovers(t.id, was.head, head);
      if (c?.covers) {
        await record(db, { companyId: t.companyId, ticketId: t.id, kind: "signoff_carried", summary: `The owner's sign-off on ${was.head.slice(0, 8)} still covers ${head.slice(0, 8)}: since then main was only merged in automatically, with no clashes and no new code from the ticket.` });
        return;
      }
    }
    if (was.state === "signed_off" && was.head && was.head !== head) throw new ReviewError(409, `The owner signed off commit ${was.head.slice(0, 8)}, but the branch is now at ${head.slice(0, 8)}, so nothing was merged. Send it back for a new review and sign-off.`);
  }
  if (d.state === "waiting") {
    // Raise its card if it went missing; either way the owner's answer is what starts the merge.
    await restoreSignoffCard(db, t, "a merge was about to start without it", head || null, because);
    throw new SignoffPendingError();
  }
  if (d.state === "reviews_pending") throw new ReviewError(409, "This ticket needs the owner's sign-off and its reviews aren't all in, so it wasn't merged.");
  // Signed off, but for another commit: the code changed after the owner approved it.
  throw new ReviewError(409, `The owner signed off commit ${d.head!.slice(0, 8)}, but ${head!.slice(0, 8)} would merge, so nothing was merged. It needs a new review and sign-off.`);
}
