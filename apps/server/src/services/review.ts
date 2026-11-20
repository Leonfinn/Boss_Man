// Review (R39): the review state carries the ticket's diff against its base, line comments
// go back to the agent as one message, and commit and PR steps are prompts from templates
// the owner can edit. Approving finishes the ticket until the merge step (R46) exists.
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { isGateMergeOf, MAIN_LOG_MAX, mergeMessageTicket, wakeCeoIfLiveUnplaced } from "./missed-merges.js";
import { deploysNothing, realUseWalkthrough, REAL_USE_REFUSAL, touchesInstallSurface, touchesRunnerCode, touchesRunnerUpdate, usabilityGated } from "@boss-man/shared";
import { deepChecks, formatReviewComments, MERGE_MISSED_AFTER_MS, parseRepoUrl, readVerdicts, renderTemplate, ticketRef, REVIEW_KINDS, riskOf, ruleFor, slotRef, type GitHostKind, type MainLogResult, type MergeLineConflictsResult, type MigrationsResult, type ReviewComment, type ReviewSlot, type WorkspaceDiff } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, checkJobs, checkResults, companies, decisions, projects, reviewRequests, runners, settings, ticketDependencies, ticketReviews, tickets } from "../db/schema.js";
import { openHoldingCard } from "./ticket-links.js";
import { RunnerGone } from "./runners.js";
import { GIT_RETRY_CARD_NOTE, GIT_RETRY_NOTE, isGitTransportFault } from "./git-transport-fault.js";
import { CI_BRANCH_PREFIX, GitHostError, type CommitChecks } from "./git-hosts.js";
import { effectivePolicy, otherReviewers } from "./review-policy.js";
import { activeRows, decide, evaluate, latestRows, recordReviewWait, reviveSkipped, setReviewOrder, skipPending, wakeReviewers, type ReviewRow } from "./review-kinds.js";
import { CHECK_AGAIN, clearCarriedCards, clearMergeCards, raiseMergeStuck, REASSIGN_REVIEW, SEND_BACK_FOR_MERGE, supersedeSignoffs, TAKE_REVIEW, WAIT_ANOTHER_HOUR, type DecisionContext } from "./decisions.js";
import { derivedSignoff, openSignoffCard, priorSignoff, raiseSignoffCard, restoreSignoffCard, signoffState, type SignoffCover } from "./signoff.js";
import { LESSON_ADD, LESSON_DROP, LESSON_EDIT, LESSON_MAX, lessonsForCeo, normalizeLesson } from "./project-brief.js";
import { record } from "./activity.js";
import { leftLineSince, lineEvent, type FailReason } from "./merge-line.js";
import { conflictNote, mergeLineApproved } from "./merge-line-conflicts.js";
import { recordFailedAttempt } from "./merge-failures.js";
import { mainMoved } from "./merge-train.js";
import { openHold, releaseReadyHolds } from "./review-holds.js";
import { carriedTitles } from "./merge-queue.js";

// BOS-1901 (BOS-1886 plan): region A lives in review-common.ts and the closure's state and helpers in review-ctx.ts. Every name
// review.ts exported before is re-exported here, so callers keep importing review.ts.
export { BOUNCE_RECORD_MAX, checkNeverFinished, checkQueueStuck, checkWaitedForLock, CI_TIMING, ciBounceRecord, FLAKE_RERUN_MAX_MS, FULL_CHECK_NEXT, gateBounceRecord, highestRisk, INFRA_CAUSE_TEXT, INFRA_RETRY_ATTEMPTS, INFRA_RETRY_BASE_MS, isSignoffPending, landingText, LOCK_RETRY_ATTEMPTS, LOCK_RETRY_BASE_MS, LOCK_RETRY_TEXT, MERGE_ACTIVITY_MS, MERGE_CARRY_KEY, MERGE_RETARGET_KEY, MERGE_TURN_DEFAULT_MIN, MERGE_TURN_KEY, MERGE_TURN_MAX_MIN, MERGE_WAIT_MS, NOTHING_CHANGED, ReviewError, ReviewHeldError, RUNNER_WAIT_MS, setInfraRetryBase, setLockRetryBase, SignoffPendingError } from "./review-common.js";
export type { GitTemplates, HoldActor, HoldInput, InfraCause, LandingStatus, LandingView, LandOptions } from "./review-common.js";
import { CHECK_MERGED_KEY, INFRA_RETRY_ATTEMPTS, INFRA_RETRY_BASE_MS, isSignoffPending, landingText, LOCK_RETRY_ATTEMPTS, LOCK_RETRY_BASE_MS, LOCK_RETRY_TEXT, MERGE_ACTIVITY_MS, MERGE_CARRY_KEY, MERGE_RETARGET_KEY, MERGE_TURN_KEY, MERGE_TURN_MAX_MIN, ReviewError, ReviewHeldError, SignoffPendingError, WAIT_FOR_CI_KEY, when, type GitTemplates, type HoldInput, type LandingStatus, type LandingView, type LandOptions, type NotifyHook } from "./review-common.js";
import { reviewContext, type ReviewDeps, type Rest } from "./review-ctx.js";
import { cancelHold, holdActorCheck, markLive, moveAfterMerge, releaseGoLiveWaiters, releaseHold } from "./review-hold-actions.js";
import { landOnce, mergePullRequest } from "./merge-attempt.js";

/**
 * The assembled review service: the `this` a moved part (review-hold-actions.ts, merge-attempt.ts and later moves) calls other methods on.
 * An interface, not `type ReviewSelf = ReturnType<…>`: a type alias is resolved as soon as a moved function's `this: ReviewSelf`
 * is read, which reviewService's own return type needs, so the alias would refer to itself (TS2456, TS2502). An interface's
 * members are resolved only when used. The other half of the fix is Rest in review-ctx.ts.
 */
export interface ReviewSelf extends ReviewService {}
type ReviewService = ReturnType<typeof reviewService>;

export function reviewService(
  db: Db,
  deps: ReviewDeps,
) {
  const ctx = reviewContext(db, deps);
  // `reviewState`, not `state`: settle and others have a local `state` (the review verdict) that would hide it.
  const { state: reviewState, landings, gate, landingBeat, phases, ciWaits, beatNow, ticketWithRepo, clashOnMain, landingStale, prTarget, approvedAndWaiting, closeAfterMerge, tellCeo, mergeStuck, checkStuck, setGitNote, tellAgent, checkMergedResult, waitForCi, mergeCarry, mergeRetarget, mergeTurnMinutes, templates, checkHoldInput, startHold, ownerSignoffOpen, refuseIfHeld } = ctx;

  return {
    setWakeHook(hook: NotifyHook) {
      reviewState.wake = hook;
    },

    /** Whether the owner's sign-off card for this ticket is still open, so a press can settle it first (BOS-471). */
    ownerSignoffOpen,

    /** The ticket's changes against its base, from the runner that holds its worktree. A review diff is measured from the merge-base with the project's current default branch (BOS-694); a last-turn diff is that turn only. */
    async diff(ticketId: string, companyId?: string, range: "base" | "last_turn" = "base"): Promise<WorkspaceDiff> {
      const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId, companyId);
      if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo, so there's no diff to review.");
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      if (!runner) throw new ReviewError(409, "The company has no runner.");
      try {
        return await deps.runners.request<WorkspaceDiff>(runner.id, (requestId) => ({ type: "workspace.diff", requestId, projectId: t.projectId, ticketId, ...(range === "last_turn" ? { range } : { baseRef: defaultBranch }) }));
      } catch (err) {
        throw new ReviewError(409, (err as Error).message);
      }
    },

    /**
     * BOS-1567: remember the head a reviewer's `review diff` served, on every review they still hold open in the latest round.
     * submit() compares it with the branch as it is then, so an approval is never stamped with a head the reviewer didn't read.
     * Returns the head stored before (null when none), so the caller can tell a later page was read on another head.
     * Never throws: a failed stamp must not block a diff.
     */
    async noteRead(ticketId: string, reviewerAgentId: string | null | undefined, head: string | null | undefined): Promise<string | null> {
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
    },

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
    async migrations(ticketId: string, companyId?: string, withOthers = false): Promise<MigrationsResult> {
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
    },

    /**
     * True when a ticket that needs code changes has none yet: its project has a repo, it isn't
     * marked "no code", and the runner reports no commits and no changed files. If the runner
     * can't answer, this is false, so an offline runner never blocks a move to review. A ticket
     * with no branch was never worked on, so it has nothing, whatever the runner says.
     */
    async needsChanges(ticketId: string, companyId?: string): Promise<boolean> {
      const { t, repoUrl } = await ticketWithRepo(ticketId, companyId);
      if (!repoUrl || t.noCode) return false;
      if (!t.branch) return true;
      const d = await this.diff(ticketId, companyId).catch(() => null);
      return !!d && !d.commits.length && !d.files.length;
    },

    /** One file of a ticket's work, from the runner that holds its repo (R77). */
    async readFile(ticketId: string, file: string, companyId?: string): Promise<{ text: string; truncated: boolean; from: "worktree" | "branch" }> {
      const { t, repoUrl } = await ticketWithRepo(ticketId, companyId);
      if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo.");
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      if (!runner) throw new ReviewError(409, "The company has no runner.");
      try {
        return await deps.runners.request(runner.id, (requestId) => ({ type: "workspace.file", requestId, projectId: t.projectId, ticketId, path: file }));
      } catch (err) {
        throw new ReviewError(409, (err as Error).message);
      }
    },

    /**
     * Records a review. Where the ticket has required reviews (see review-kinds.ts) an agent's verdict
     * fills its own; the ticket moves only when they are all in. Changes requested go to the agent
     * as one message and move the ticket back to in progress; approval finishes it.
     */
    async submit(
      ticketId: string,
      input: { verdict: "approved" | "changes_requested"; comments?: ReviewComment[]; summary?: string; /** Optional one-line lesson learned, when sending it back (R-review-lessons); the owner decides. */ lesson?: string; reviewer: string; reviewerAgentId?: string | null; /** Which of the agent's reviews, when it holds several. */ kind?: string; companyId?: string; causedByRunId?: string | null; /** Land in the background and return at once (the owner's page polls `landing`). */ background?: boolean; /** "Passed, hold merge" (BOS-808): an approval that does not merge until the hold ends. */ hold?: HoldInput },
    ) {
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
    },

    /** After a verdict, an overrule or a new order: wake who is next, send the work back, or approve it. */
    async settle(t: typeof tickets.$inferSelect, o: { verdict: "approved" | "changes_requested"; reviewer: string; reviewerAgentId: string; background?: boolean; causedByRunId?: string | null; before: ReviewRow[] }) {
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
    },

    /** Approval is final unless the owner signs off (R48); then it asks them. The CEO cannot stand in for that. */
    async approve(t: typeof tickets.$inferSelect, o: { reviewer: string; reviewerAgentId?: string | null; background?: boolean; causedByRunId?: string | null }) {
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
    },

    /** The merge an approval starts. A merge that waits on another ticket (BOS-1173) is a normal outcome for the approver: held, not an error. */
    async landApproved(ticketId: string, o: { reviewer: string; background?: boolean; causedByRunId?: string | null }) {
      try {
        if (o.background) return { verdict: "approved" as const, outcome: "landing" as const, delivered: null, landing: await this.startLanding(ticketId, o.reviewer, o.causedByRunId) };
        return { verdict: "approved" as const, ...(await this.landVisible(ticketId, o.reviewer, o.causedByRunId)) };
      } catch (err) {
        const h = err instanceof ReviewHeldError ? await openHold(db, ticketId) : null;
        if (h && !h.reviewerAgentId) return { verdict: "approved" as const, outcome: "held" as const, delivered: (err as Error).message };
        throw err;
      }
    },

    /** Changes requested: a review that keeps coming back goes to the owner instead of another round (R49). */
    async sendBackRound(t: typeof tickets.$inferSelect, o: { reviewer: string; comments: ReviewComment[]; text: string; parts?: { notes: string; comments: ReviewComment[] }[]; causedByRunId?: string | null }) {
      const round = await deps.loops.reviewRound({ ticketId: t.id, reviewer: o.reviewer, comments: o.comments, message: o.text, parts: o.parts });
      if (round.escalated) return { verdict: "changes_requested" as const, outcome: "escalated" as const, delivered: `held: the review looks stuck, so the CEO (or the owner, if the CEO can't settle it) decides what happens next (decision ${round.escalated})`, message: o.text, round: round.round };
      const delivered = await this.sendBack(t.id, o.text, o.reviewer, o.causedByRunId);
      return { verdict: "changes_requested" as const, outcome: "sent_back" as const, delivered, message: o.text, round: round.round };
    },

    /**
     * BOS-1958: the author moved a ticket that is still in review back to review. Each reviewer in the open round who asked for
     * changes is asked again when the branch head differs from the one their verdict was given on (a verdict with no recorded
     * head counts as changed). Approved reviews are left alone. Returns the reviewers' names.
     */
    async reAskChangesRequested(ticketId: string, companyId: string, causedByRunId?: string | null): Promise<string[]> {
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
    },

    /** The CEO sets the order of a ticket's reviews, for when one depends on another. */
    async sequence(ticketId: string, order: string[], byAgentId: string, companyId: string) {
      const { t } = await ticketWithRepo(ticketId, companyId);
      const woken = await setReviewOrder(db, t, order, byAgentId);
      if (reviewState.wake) await wakeReviewers(db, t, woken, (id, i) => reviewState.wake!(id, i));
      return woken.length;
    },

    /** The CEO overrules a "changes requested", with a reason kept on the ticket. Owner sign-off still applies. */
    async overrule(ticketId: string, input: { kind: string; reason: string; byAgentId: string; companyId: string; causedByRunId?: string | null; background?: boolean }) {
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
    },

    /**
     * The CEO starts a fresh merge attempt on an approved ticket the gate refused (BOS-684), the same retry the sweep
     * makes once per server: the whole gate runs again on the connected runner. Only an approved ticket still in review;
     * it never skips the checks (that stays the owner's), and an open sign-off card still holds it (startLanding).
     */
    async retryMerge(ticketId: string, input: { byAgentId: string; companyId: string; causedByRunId?: string | null }) {
      const { t } = await ticketWithRepo(ticketId, input.companyId);
      if (t.systemState === "done") throw new ReviewError(409, "That ticket is already done.");
      if (t.systemState !== "review") throw new ReviewError(409, "That ticket isn't in review, so there is no merge to retry.");
      const rows = await latestRows(db, ticketId);
      if (!rows.length || evaluate(rows) !== "passed") throw new ReviewError(409, "That ticket isn't approved yet: every review must pass before a merge can be retried.");
      // Refused before anything is cleared or recorded, so a no-op press leaves the ticket as it was.
      if (landings.get(ticketId)?.state === "running" && !(await landingStale(ticketId))) throw new ReviewError(409, "This ticket is already being checked and merged.");
      if (await ownerSignoffOpen(ticketId)) throw new ReviewError(409, "The owner's sign-off is open on this ticket; nothing can merge until it is answered.");
      if (await openHold(db, ticketId)) throw new ReviewHeldError();
      await record(db, { companyId: t.companyId, agentId: input.byAgentId, ticketId, kind: "merge_retried", summary: "The CEO started the merge again." });
      // An older merge card no longer describes the state of the ticket: this attempt will raise its own if it fails.
      await clearMergeCards(db, ticketId, { by: "system", note: "Replaced by a new merge attempt the CEO started.", at: new Date().toISOString() });
      return this.startLanding(ticketId, "the CEO (retrying the merge)", input.causedByRunId);
    },

    // BOS-1901: the hold and go-live actions live in review-hold-actions.ts; each delegate passes the service as `this`.
    holdActorCheck(...a: Rest<typeof holdActorCheck>) { return holdActorCheck.call(this, ctx, ...a); },
    releaseHold(...a: Rest<typeof releaseHold>) { return releaseHold.call(this, ctx, ...a); },
    cancelHold(...a: Rest<typeof cancelHold>) { return cancelHold.call(this, ctx, ...a); },
    releaseGoLiveWaiters(...a: Rest<typeof releaseGoLiveWaiters>) { return releaseGoLiveWaiters.call(this, ctx, ...a); },
    markLive(...a: Rest<typeof markLive>) { return markLive.call(this, ctx, ...a); },
    moveAfterMerge(...a: Rest<typeof moveAfterMerge>) { return moveAfterMerge.call(this, ctx, ...a); },

    /**
     * The landing the page should show. A running marker whose ticket has gone quiet for longer
     * than a merge can take is a leftover: it is marked stale so the owner can try again.
     */
    async landing(ticketId: string): Promise<LandingView> {
      const status = landings.get(ticketId);
      if (!status) return null;
      if (status.state === "finished") return status;
      return { ...status, stale: await landingStale(ticketId), phase: phases.get(ticketId) ?? "checking" };
    },

    /**
     * One plain line on where a ticket's merge stands, for every list of sign-off and merge cards (DR-014), built on the
     * server so agents copy it: queued / checking / merging / waiting to retry / looks stuck / finished (with why).
     * Null when no merge has run since the server started.
     */
    async mergeState(ticketId: string): Promise<string | null> {
      const l = await this.landing(ticketId);
      if (!l) return null;
      const at = (iso: string) => new Date(iso).toISOString().slice(11, 16) + " UTC";
      if (l.state === "finished") return `merge finished: ${l.text}`;
      if (l.stale) return `merge looks stuck since ${at(l.startedAt)}; nothing is running now`;
      const word = { queued: "queued for a check slot", checking: "checking", merging: "merging", waiting_to_retry: "waiting to try again after the runner restarted", retrying_git: "retrying after a push/fetch failure to the git host" }[l.phase ?? "checking"];
      return `merge ${word} (since ${at(l.startedAt)})`;
    },

    /** The host's checks on the ticket's branch head as data, for the ticket page (BOS-1418). Null whenever there's nothing to show, including any host error. */
    async branchChecks(ticketId: string, companyId?: string): Promise<(CommitChecks & { sha: string }) | null> {
      try {
        return await this.branchChecksOrThrow(ticketId, companyId);
      } catch {
        return null;
      }
    },

    async branchChecksOrThrow(ticketId: string, companyId?: string): Promise<(CommitChecks & { sha: string }) | null> {
      const { t, repoUrl, gitHost, gitApiBase } = await ticketWithRepo(ticketId, companyId);
      if (!t.branch || t.mergeCommit || t.systemState === "done" || !deps.gitHosts) return null;
      const a = repoUrl ? parseRepoUrl(repoUrl) : null;
      const token = await deps.gitToken?.(t.companyId);
      if (!a || (gitHost !== "github" && gitHost !== "gitea") || !gitApiBase || !token) return null;
      const cfg = { kind: gitHost as GitHostKind, apiBase: gitApiBase, owner: a.owner, repo: a.repo };
      const sha = await deps.gitHosts.branchHead(cfg, token, t.branch);
      return { ...(await deps.gitHosts.checks(cfg, token, sha)), sha };
    },

    /**
     * One line for `tickets read` (DR-024 #2): the host's checks on the head of the ticket's branch.
     * Null when there's nothing to say (no branch, already merged, no known host or token). A host
     * that refuses the token is said plainly, never shown as "no checks".
     */
    async branchChecksLine(ticketId: string, companyId?: string): Promise<string | null> {
      try {
        const r = await this.branchChecksOrThrow(ticketId, companyId);
        if (!r) return null;
        const c = r;
        const sha = r.sha;
        const at = sha.slice(0, 8);
        const names = c.failing.join(", ");
        if (c.state === "none") return `CI on branch head ${at}: no checks reported (yet).`;
        if (c.state === "failed") return `CI on branch head ${at}: FAILED${names ? ` (${names})` : ""}.`;
        if (c.state === "pending") return `CI on branch head ${at}: still running.`;
        return `CI on branch head ${at}: passed${c.total ? ` (${c.total} check${c.total === 1 ? "" : "s"})` : ""}.`;
      } catch (err) {
        if (err instanceof GitHostError) {
          return `CI on branch head: not available (${err.message}).`;
        }
        return null;
      }
    },

    /** The in-memory merge gate's checks: running and waiting (BOS-420 counts them before a server update). */
    gateState: () => gate.state(),
    /** Looks at the gate's queue again now: a server update's soft hold lifted (BOS-420). */
    gatePump: () => gate.pump(),

    /** Every merge this process has running, with its phase, for the merge queue screen (BOS-587). */
    runningMerges(): Array<{ ticketId: string; startedAt: string; startedBy: string; phase?: "queued" | "checking" | "merging" | "waiting_to_retry" | "retrying_git"; ci?: { since: string; waiting: string[] } }> {
      return [...landings.entries()].flatMap(([ticketId, l]) => {
        if (l.state !== "running") return [];
        const ci = ciWaits.get(ticketId);
        return [{ ticketId, startedAt: l.startedAt, startedBy: l.startedBy, phase: phases.get(ticketId) ?? ("checking" as const), ...(ci ? { ci: { since: new Date(ci.since).toISOString(), waiting: ci.waiting } } : {}) }];
      });
    },

    /**
     * BOS-1645: merges in their "merging" phase (past the check: pushing, then recording), per company. A runner swap waits
     * for these: cutting the runner off between push and record leaves main with a merge its ticket doesn't know about.
     */
    async landingMergesByCompany(): Promise<Map<string, number>> {
      let ids = [...landings.entries()].filter(([id, l]) => l.state === "running" && phases.get(id) === "merging").map(([id]) => id);
      const out = new Map<string, number>();
      if (!ids.length) return out;
      // BOS-1954: a merge whose check job is still queued has not pushed anything: the phase is "merging" from before its
      // prepare, but its check can't start while the update holds new checks, so counting it made the swap wait for a merge
      // that waited for the swap (a deadlock only a server restart cleared). Once the job runs it counts as a running check
      // (runner-busy.ts); once it has passed, the push is what is counted here.
      const waitingOnCheck = new Set((await db.select({ ticketId: checkJobs.ticketId }).from(checkJobs).where(and(inArray(checkJobs.ticketId, ids), eq(checkJobs.kind, "merge"), eq(checkJobs.state, "queued")))).map((r) => r.ticketId));
      ids = ids.filter((id) => !waitingOnCheck.has(id));
      if (!ids.length) return out;
      const rows = await db.select({ companyId: tickets.companyId }).from(tickets).where(inArray(tickets.id, ids));
      for (const r of rows) out.set(r.companyId, (out.get(r.companyId) ?? 0) + 1);
      return out;
    },

    /**
     * BOS-1645 (R27): records the merges on main the gate never recorded (its answer was lost, e.g. to a runner swap between
     * push and record). For each project with a repo whose runner answers workspace.mainLog, it reads main's newest first-parent
     * commits, and every `Merge "..." (<ticket id>)` naming one of the project's tickets that has no mergeCommit is recorded as
     * the gate would have (recordMissedMerge). Then, per company read, a live commit that still can't be placed wakes the CEO
     * once. `projectId` limits it to one project (after a landing). Runs on the leader only, one pass at a time; never throws.
     */
    async recordMissedMerges(projectId?: string): Promise<{ recorded: string[] }> {
      const recorded: string[] = [];
      if (deps.isLeader && !deps.isLeader()) return { recorded };
      if (reviewState.missedSweep) return reviewState.missedSweep.then(() => ({ recorded }));
      const pass = (async () => {
        const rows = await db
          .select({ id: projects.id, companyId: projects.companyId, repoUrl: projects.repoUrl, target: projects.defaultBranch })
          .from(projects)
          .where(projectId ? eq(projects.id, projectId) : isNotNull(projects.repoUrl));
        const read = new Map<string, Array<{ sha: string; subject: string; message: string }>>();
        for (const p of rows) {
          if (!p.repoUrl) continue;
          try {
            const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, p.companyId));
            if (!runner || !deps.runners.isConnected(runner.id) || !deps.runners.can(runner.id, "main-log")) continue;
            const ask = (filesFor?: string[]) =>
              deps.runners.request<MainLogResult>(runner.id, (requestId) => ({ type: "workspace.mainLog", requestId, projectId: p.id, target: p.target, max: MAIN_LOG_MAX, ...(filesFor?.length ? { filesFor } : {}) }), 60_000);
            const log = (await ask())?.commits ?? [];
            read.set(p.companyId, [...(read.get(p.companyId) ?? []), ...log]);
            // Newest first, so a ticket merged twice keeps its newest merge.
            const named = new Map<string, (typeof log)[number]>();
            for (const c of log) {
              const id = typeof c.message === "string" ? mergeMessageTicket(c.message) : null;
              if (id && !named.has(id)) named.set(id, c);
            }
            if (!named.size) continue;
            // Only a commit whose whole message is exactly this ticket's gate merge message counts (Jane, BOS-1645): a
            // ticket title is agent-written, so a message merely naming an id must never close another ticket.
            const missing = (
              await db
                .select({ id: tickets.id, title: tickets.title })
                .from(tickets)
                .where(and(inArray(tickets.id, [...named.keys()]), eq(tickets.projectId, p.id), isNull(tickets.mergeCommit)))
            ).filter((t) => isGateMergeOf(named.get(t.id)!.message, t));
            if (!missing.length) continue;
            // A second read for the changed files of just these, so touchesRunner is known (BOS-1021) rather than assumed.
            const shas = missing.slice(0, 20).map((m) => named.get(m.id)!.sha);
            const files = new Map(((await ask(shas).catch(() => null))?.commits ?? []).filter((c) => c.files).map((c) => [c.sha, c.files!]));
            for (const m of missing) {
              const c = named.get(m.id)!;
              if (await this.recordMissedMerge(m.id, c.sha, { at: c.at, files: files.get(c.sha) }).catch(() => false)) recorded.push(m.id);
            }
          } catch {
            // A runner away or too slow: the next pass tries again.
          }
        }
        for (const [companyId, onMain] of read) await wakeCeoIfLiveUnplaced(db, companyId, onMain, reviewState.wake).catch(() => false);
      })();
      reviewState.missedSweep = pass;
      try {
        await pass;
      } finally {
        reviewState.missedSweep = null;
      }
      return { recorded };
    },

    /**
     * Records one merge found on main without a record (BOS-1645): mergeCommit and mergedAt (the commit's own time, so merge
     * order stays right), the ticket moved on as after a merge (done, or back to its assignee for after-merge checks), and the
     * assignee told. The claim (`mergeCommit is null`) makes it once only, whatever runs beside it; a ticket whose own merge is
     * running here is left to that merge. A ticket already done (closed by hand) only gets the merge facts.
     */
    async recordMissedMerge(ticketId: string, commit: string, opts: { at?: string; files?: string[] } = {}): Promise<boolean> {
      if (landings.get(ticketId)?.state === "running") return false;
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t || t.mergeCommit) return false;
      const at = opts.at && !Number.isNaN(Date.parse(opts.at)) ? new Date(opts.at) : new Date();
      const files = opts.files;
      const runnerFacts = { touchesRunner: files ? touchesRunnerCode(files) : true, touchesRunnerUpdate: files ? touchesRunnerUpdate(files) : null, deploysNothing: files ? deploysNothing(files) : null };
      const [claimed] = await db
        .update(tickets)
        .set({ mergeCommit: commit, mergedAt: at, ...runnerFacts })
        .where(and(eq(tickets.id, ticketId), isNull(tickets.mergeCommit)))
        .returning({ id: tickets.id });
      if (!claimed) return false;
      const short = commit.slice(0, 12);
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_recorded_late", summary: `Merged as ${short} at ${at.toISOString()}, but Boss Man never got the answer (the runner was cut off between push and record). Found on main and recorded now.` });
      if (t.systemState === "done") return true;
      await clearMergeCards(db, ticketId, { by: "system", note: `The merge is on main as ${short}; recorded late.`, at: new Date().toISOString() }).catch(() => undefined);
      const r = await closeAfterMerge(t, commit, null, files, at);
      // closeAfterMerge already told the assignee when after-merge checks are due now; otherwise say what happened.
      const told = !!(r.detail as { afterMerge?: unknown }).afterMerge && !(r.detail as { goLiveWait?: unknown }).goLiveWait;
      if (!told && t.assigneeAgentId)
        await tellAgent(
          t,
          `Your merge is on main as ${short}, but Boss Man never recorded it (the runner was cut off between the push and the record), so the ticket kept showing "not merged". It is recorded now${(r.detail as { goLiveWait?: unknown }).goLiveWait ? "; the after-merge checks start when it is live" : " and the ticket is done"}. Nothing to redo: don't merge or push it again.`,
          "merge recorded late",
        ).catch(() => null);
      return true;
    },

    /** True while a merge for this ticket has said it is alive within the merge window (a check or lock wait under way). */
    landingActive(ticketId: string): boolean {
      return Date.now() - (landingBeat.get(ticketId) ?? 0) <= MERGE_MISSED_AFTER_MS;
    },

    /**
     * The files this ticket's branch would clash with on the default branch. Null when it merges cleanly
     * or when that can't be told (no repo, no connected runner, an older runner, or a failed check): null
     * means "carry on as if it merges", so a check that can't answer never holds a reviewer back (BOS-426).
     * A real clash whose file list is unknown is an empty array, which callers must read as a clash.
     * A clean merge must never come back as [] (BOS-1074: [] is truthy, so every idle review woke its
     * author with "no longer merges").
     */
    async branchClash(ticketId: string): Promise<string[] | null> {
      try {
        const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
        if (!repoUrl || !t.branch) return null;
        return await clashOnMain(t, defaultBranch);
      } catch {
        return null;
      }
    },

    /**
     * Which approved branches ahead in the merge line really conflict with this ticket's (BOS-1411). A read-only
     * merge-tree on the runner; [] when there is nothing to tell (the only approved work is this ticket, the runner
     * is away or too old, or nothing clashes). A warning only: it never holds a card or changes a merge, so every
     * answer that isn't a real conflict reads as "no warning". Refs are resolved for the note.
     */
    async mergeLineClashes(ticketId: string): Promise<Array<{ ticketId: string; ref: string | null; title: string; files: string[] }>> {
      try {
        const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
        if (!repoUrl || !t.branch) return [];
        const others = await mergeLineApproved(db, t.projectId, t.id);
        if (!others.length) return [];
        const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
        if (!runner || !deps.runners.isConnected(runner.id) || !deps.runners.can(runner.id, "merge-conflicts")) return [];
        const r = await deps.runners.request<MergeLineConflictsResult>(
          runner.id,
          (requestId) => ({ type: "workspace.mergeLine", requestId, projectId: t.projectId, ticketId: t.id, target: defaultBranch, branches: others.map((o) => ({ ticketId: o.id, branch: o.branch })) }),
          60_000,
        );
        const byId = new Map(others.map((o) => [o.id, o]));
        const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
        const rows = await db.select({ id: tickets.id, title: tickets.title, number: tickets.number }).from(tickets).where(inArray(tickets.id, (r?.conflicts ?? []).map((x) => x.ticketId)));
        const info = new Map(rows.map((x) => [x.id, { title: x.title, ref: ticketRef(c?.prefix, x.number) }]));
        return (r?.conflicts ?? [])
          .filter((x) => x.clashes && byId.has(x.ticketId))
          .map((x) => ({ ticketId: x.ticketId, ref: info.get(x.ticketId)?.ref ?? null, title: info.get(x.ticketId)?.title ?? byId.get(x.ticketId)!.branch, files: x.files.slice(0, 20) }));
      } catch {
        return [];
      }
    },

    /**
     * Whether the owner's sign-off on `signed` still covers the branch head: only clean automatic merges of the
     * default branch came in since (BOS-734, DR-038). The runner works it out from git; null when it can't say,
     * which every caller reads as "does not cover".
     */
    async signoffCovers(ticketId: string, signed: string, head?: string): Promise<SignoffCover | null> {
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
    },

    /**
     * Before an owner's "Approve and merge" press: null when the card's commit still stands (it is the branch head,
     * or only clean main merges came in), otherwise the plain reason it can't, after replacing the card with one for
     * the current head. The owner is never left holding a card that is bound to fail (BOS-734).
     */
    async signoffStale(ticketId: string, cardHead: string): Promise<string | null> {
      const head = await this.diff(ticketId).then((x) => x.head || null, () => null);
      if (!head || head === cardHead) return null;
      const c = await this.signoffCovers(ticketId, cardHead, head);
      if (c?.covers) return null;
      // The runner couldn't say: keep the card, refuse the press, nothing is replaced or merged.
      if (!c) return `The branch changed after this card was raised (${cardHead.slice(0, 8)} is now ${head.slice(0, 8)}) and Boss Man couldn't check what came in right now, so nothing was merged. Try again in a few minutes.`;
      // New code of the ticket's own: the reviewers haven't seen it, so no new card until they pass it again (security review, BOS-734).
      return this.withdrawStaleSignoff(ticketId, cardHead, head, c.reason || "new code came in");
    },

    /** Withdraws a sign-off card for older code and sends the ticket back for a new review round; the next round raises the new card. */
    async withdrawStaleSignoff(ticketId: string, cardHead: string, head: string, why: string): Promise<string> {
      const { t } = await ticketWithRepo(ticketId);
      await supersedeSignoffs(db, t.id, { by: "system", note: `The branch changed after the card was raised (${why}).`, at: new Date().toISOString() });
      await record(db, { companyId: t.companyId, ticketId: t.id, kind: "signoff_card_moved", summary: `The sign-off card was for ${cardHead.slice(0, 8)} but the branch is at ${head.slice(0, 8)} (${why}), so it was withdrawn and the ticket sent back for a new review.` });
      await this.sendBack(t.id, `The owner's sign-off card was for ${cardHead.slice(0, 8)}, but the branch is now at ${head.slice(0, 8)} (${why}). The card was withdrawn. Make sure the work is committed, then move the ticket back to review for a new review round and sign-off.`, "Boss Man");
      return `The branch changed after this card was raised (${why}), so it can't be merged as it stands. The card was withdrawn and the ticket sent back for a new review; a new card comes once the reviewers have passed the current code.`;
    },

    /** Claims the ticket's merge marker, so the page shows the merge from its first moment. */
    async claimLanding(ticketId: string, reviewer: string): Promise<string> {
      const existing = landings.get(ticketId);
      if (existing?.state === "running") {
        if (!(await landingStale(ticketId))) throw new ReviewError(409, "This ticket is already being checked and merged.");
        // Only replace the marker we judged stale: another approval may have claimed it while we checked the heartbeat.
        if (landings.get(ticketId) !== existing) throw new ReviewError(409, "This ticket is already being checked and merged.");
        landings.delete(ticketId);
      }
      // Claimed before the first await, so two approvals at the same moment cannot both start a landing.
      const startedAt = new Date().toISOString();
      landings.set(ticketId, { state: "running", startedAt, command: null, startedBy: reviewer });
      phases.delete(ticketId);
      // A ticket can sit in review for hours before its last reviewer approves. Count the merge itself as
      // activity now, so the very first poll of a fresh merge is never judged stale from that quiet spell.
      await beatNow(ticketId);
      return startedAt;
    },

    /**
     * Lands and waits, as land() does (a sign-off card's answer still finishes the merge before it returns),
     * but keeps the running marker for as long as it takes so every page shows the merge in flight.
     */
    async landVisible(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions) {
      const startedAt = await this.claimLanding(ticketId, reviewer);
      try {
        return await this.land(ticketId, reviewer, causedByRunId, opts);
      } finally {
        // The ticket page reloads when a running marker goes away; a finished banner comes from startLanding.
        // Only our own marker (BOS-1769): a landing that outlived its pass through the line must not clear the one that replaced it.
        const m = landings.get(ticketId);
        if (m?.state === "running" && m.startedAt === startedAt) landings.delete(ticketId);
        void this.afterLandingSweep(ticketId);
      }
    },

    /** BOS-1645: after every merge attempt, look at main for a merge that was pushed but not recorded (this one's included). */
    async afterLandingSweep(ticketId: string) {
      const [t] = await db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId)).catch(() => []);
      if (t) await this.recordMissedMerges(t.projectId).catch(() => undefined);
    },

    /** Runs land() without holding the request (the check can take minutes); the outcome is kept for the page to poll. */
    async startLanding(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<LandingStatus> {
      // Nothing can merge while the owner's sign-off card is open (BOS-471), a reviewer holds the merge (BOS-808), a
      // card holds it or it waits on another ticket (BOS-1173): refuse before claiming the landing, so a press cannot
      // leave a retry marker or a retry card behind for a ticket that is simply waiting.
      await refuseIfHeld(ticketId);
      const startedAt = await this.claimLanding(ticketId, reviewer);
      let ctx: Awaited<ReturnType<typeof ticketWithRepo>>;
      try {
        ctx = await ticketWithRepo(ticketId);
      } catch (err) {
        landings.delete(ticketId);
        // Waiting on the sign-off is not a failure: no trail, no card (BOS-471).
        if (isSignoffPending(err)) throw err;
        // The approval is already recorded: leave a trail and a card, as land() does, so the ticket is not silently stuck.
        const message = err instanceof Error ? err.message : String(err);
        const [row] = await db.select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ticketId));
        if (row) {
          await record(db, { companyId: row.companyId, ticketId, kind: "merge_failed", summary: `Approved, but the merge couldn't start: ${message}` });
          await mergeStuck(row, message);
        }
        throw err;
      }
      const { t, defaultBranch, verifyCommand, deepVerifyCommand, repoUrl } = ctx;
      const command = repoUrl ? ([verifyCommand, deepChecks(t.risk) ? deepVerifyCommand : null].filter(Boolean) as string[]).join(" && ") || null : null;
      const running: LandingStatus = { state: "running", startedAt, command, startedBy: reviewer };
      landings.set(ticketId, running);
      void (async () => {
        let text: string;
        let outcome = "failed";
        let url: string | null = null;
        try {
          const r = await this.land(ticketId, reviewer, causedByRunId, opts);
          const [a] = t.assigneeAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, t.assigneeAgentId)) : [];
          outcome = r.outcome;
          url = (r.detail as { url?: string | null } | undefined)?.url ?? null;
          text = landingText(r, { branch: defaultBranch, assignee: a?.name ?? null });
        } catch (err) {
          // A hold found mid-merge (a merge-check fix or waits-on link marked while the check or CI ran, BOS-1173/1643)
          // is a wait, not a failure: say "held" with its own message, as landApproved does for the visible merge.
          if (err instanceof ReviewHeldError) {
            outcome = "held";
            text = (err as Error).message;
          } else text = `Approved, but not merged: ${(err as Error).message}`;
        }
        // Only over our own marker (BOS-1769): a newer landing that replaced this one keeps showing as running.
        if (landings.get(ticketId) === running) landings.set(ticketId, { state: "finished", outcome, text, url, finishedAt: new Date().toISOString() });
        await this.afterLandingSweep(ticketId);
      })();
      return running;
    },

    /** Moves the ticket back to in progress and gives the agent the review. */
    async sendBack(ticketId: string, text: string, reviewer: string, causedByRunId?: string | null) {
      const { t } = await ticketWithRepo(ticketId);
      await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
      return tellAgent({ ...t, systemState: "in_progress" }, text, "review", causedByRunId);
    },

    /**
     * A stalled-review card's action (BOS-404, BOS-426, BOS-433 fix B): the review the card names is still
     * open, so do what the CEO or owner chose and record it on the ticket. Returns false when the review
     * has moved on (a verdict landed, the round changed, the ticket left review), so the card can be kept open.
     */
    async reviewStall(ctx: Extract<DecisionContext, { type: "review_stall" }>, answer: string, byAgentId: string | null): Promise<boolean> {
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
    },

    /**
     * What approval does (R46, R47). Without a repo the ticket is simply done. With one, the
     * project's check runs in the worktree, then the branch is merged into the project's
     * default branch, and the merge closes the ticket. A failed check, a conflict or
     * uncommitted work sends the ticket back to the agent with what to do.
     */
    async land(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<{ outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted" | "carried" | "migration_journal" | "branch_changed"; delivered: string | null; detail?: unknown }> {
      // BOS-1769: this landing's pass through the line began now; once the ticket leaves review after this, the landing is over.
      const begun = new Date();
      const [lineRow] = await db.select({ id: tickets.id, companyId: tickets.companyId, projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId));
      // An adopted merge (BOS-1371) carries on a check already running: it is not a new attempt.
      if (lineRow && !opts?.adopt) await lineEvent(db, lineRow, { event: "attempt", by: reviewer.slice(0, 200) });
      // BOS-1461: a merge attempt that does not land leaves an attempt_failed row with its reason.
      const failed = async (reason: FailReason, detail?: unknown, note?: string) => {
        if (!lineRow) return;
        const jobId = (detail as { keptLog?: { jobId?: unknown } } | null | undefined)?.keptLog?.jobId;
        // BOS-1860: a network blip the merge retries by itself raises no "Merges keep failing" alert; only a second failure counts.
        await recordFailedAttempt(db, reason === "git_transport_retried" ? {} : { alert: deps.alert }, lineRow, reason, typeof jobId === "string" ? jobId : undefined, note);
      };
      // BOS-1860: one retry by itself when a push or fetch to the git host failed on the network. gitTwice: it failed again.
      let gitRetried = false;
      let gitTwice = false;
      // An earlier attempt's "retrying" or "card is with the CEO" flag on the note no longer says what is happening.
      await setGitNote(ticketId, null, [GIT_RETRY_NOTE, GIT_RETRY_CARD_NOTE]).catch(() => undefined);
      try {
        // A merge check that only waited too long for the shared lock is queued again, with a longer pause each time.
        // The ticket stays in review; the pause counts as activity so the unmerged-approvals sweep leaves it alone.
        let goneTries = 0;
        for (let attempt = 1; ; attempt++) {
          let r: Awaited<ReturnType<typeof this.landOnce>> | { outcome: "runner_gone"; delivered: null; detail: { message: string } };
          try {
            r = await this.landOnce(ticketId, reviewer, causedByRunId, opts, begun);
          } catch (err) {
            if (!(err instanceof RunnerGone)) {
              const message = err instanceof Error ? err.message : String(err);
              const transport = !isSignoffPending(err) && !(err instanceof ReviewHeldError) && isGitTransportFault(message);
              // A copy no longer in charge retries nothing: the outer catch hands it to the server now in charge (DR-026).
              if (transport && !gitRetried && (!deps.isLeader || deps.isLeader())) {
                gitRetried = true;
                const { t } = await ticketWithRepo(ticketId);
                await failed("git_transport_retried", undefined, message);
                const pause = INFRA_RETRY_BASE_MS;
                await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `Retrying after a push/fetch failure to the git host (${message.slice(0, 200)}); trying once more in ${Math.max(1, Math.round(pause / 1000))}s. The work is unchanged; nothing to do.` });
                await setGitNote(ticketId, GIT_RETRY_NOTE).catch(() => undefined);
                phases.set(ticketId, "retrying_git");
                const beat = setInterval(() => void beatNow(ticketId).catch(() => undefined), MERGE_ACTIVITY_MS);
                beat.unref?.();
                try {
                  await new Promise((resolve) => setTimeout(resolve, pause));
                } finally {
                  clearInterval(beat);
                }
                const [now] = await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, ticketId));
                if (now?.state !== "review" || (await leftLineSince(db, ticketId, begun))) return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while the merge waited to retry after a push/fetch failure, so it was not retried." } };
                if (deps.isLeader && !deps.isLeader()) return { outcome: "check_stuck", delivered: null, detail: { note: "Handed over while the merge waited to retry; the server now in charge restarts it." } };
                attempt--;
                continue;
              }
              if (transport && gitRetried) gitTwice = true;
              throw err;
            }
            r = { outcome: "runner_gone", delivered: null, detail: { message: err.message } };
          }
          if (r.outcome === "runner_gone") {
            // The runner restarted or went away under the merge (DR-014): the work is fine. Try again by itself, keeping the place in line.
            const { t } = await ticketWithRepo(ticketId);
            const message = (r.detail as { message: string }).message;
            if (!deps.isLeader || deps.isLeader()) await failed("restart", undefined, message);
            // A copy that is no longer in charge stops quietly (DR-026): the server now in charge starts this merge again, so no retries and no card here.
            if (deps.isLeader && !deps.isLeader()) {
              await record(db, { companyId: t.companyId, ticketId, kind: "merge_failed", summary: "The merge was cut off by the hand-over; the server now in charge starts it again. Nothing to do." });
              return { outcome: "check_stuck", delivered: null, detail: { note: "Cut off by the hand-over; the server now in charge restarts it." } };
            }
            goneTries++;
            if (goneTries > INFRA_RETRY_ATTEMPTS) {
              await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The runner kept going away under the merge (${message}); the merge card is with the CEO first.` });
              await checkStuck(t, "the merge", "was cut off because the runner restarted or went away", message);
              return { outcome: "check_stuck", delivered: null, detail: r.detail };
            }
            const pause = INFRA_RETRY_BASE_MS * 2 ** (goneTries - 1);
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `Runner restarted: the merge was cut off (${message}); running it again (try ${goneTries} of ${INFRA_RETRY_ATTEMPTS}, in ${Math.max(1, Math.round(pause / 1000))}s). Nothing to do.` });
            phases.set(ticketId, "waiting_to_retry");
            const beat = setInterval(() => void beatNow(ticketId).catch(() => undefined), MERGE_ACTIVITY_MS);
            beat.unref?.();
            try {
              await new Promise((resolve) => setTimeout(resolve, pause));
            } finally {
              clearInterval(beat);
            }
            const [now] = await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, ticketId));
            if (now?.state !== "review" || (await leftLineSince(db, ticketId, begun))) return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while the merge waited, so it was not retried." } };
            if (deps.isLeader && !deps.isLeader()) return { outcome: "check_stuck", delivered: null, detail: { note: "Handed over while the merge waited; the server now in charge restarts it." } };
            attempt--;
            continue;
          }
          if (r.outcome === "merged") {
            // BOS-1515 (B2): main moved, so tickets waiting in this project's merge train try a merge on main again.
            if (lineRow) mainMoved(lineRow.projectId);
            void this.retryHeldBy(ticketId).catch(() => undefined);
            // Approved work held on this ticket goes on once it is live too (BOS-1173); the sweep catches a later go-live.
            void this.releaseHolds().catch(() => undefined);
          }
          if (r.outcome === "verify_failed") await failed("check_failed", r.detail);
          else if (r.outcome === "conflicts") await failed("conflict");
          else if (r.outcome === "uncommitted" || r.outcome === "migration_journal") await failed("landing_refused", r.detail, r.outcome);
          // A stuck check is a gate fault; the quiet stops (left review, handed over) carry a `note` and are not failures.
          else if (r.outcome === "check_stuck" && !(r.detail as { note?: unknown } | undefined)?.note) await failed("gate_fault", r.detail);
          // A lock wait is retried by itself and is no failure until it gives up; a main that moved is one each time.
          else if (r.outcome === "lock_wait" && (r.detail as { status?: string } | undefined)?.status === "main_moved") await failed("main_moved");
          else if (r.outcome === "lock_wait" && attempt >= LOCK_RETRY_ATTEMPTS) await failed("lock_timeout");
          if (r.outcome !== "lock_wait") return r;
          // BOS-1752: a copy no longer in charge retries nothing; the server now in charge restarts this merge (DR-026).
          if (deps.isLeader && !deps.isLeader()) return { outcome: "check_stuck", delivered: null, detail: { note: "Handed over while the merge waited; the server now in charge restarts it." } };
          const { t } = await ticketWithRepo(ticketId);
          // A main_moved lock wait carries only { status } (no command or output): BOS-1604 crashed here with "reading 'slice'".
          const d = r.detail as { command?: string; output?: string; status?: string } | undefined;
          if (attempt >= LOCK_RETRY_ATTEMPTS) {
            const moved = d?.status === "main_moved";
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: moved ? `The merge gave up after ${attempt} tries: main kept moving before it could land; it's in your Decisions.` : `Merge check gave up waiting for the lock after ${attempt} tries; the merge card is with the CEO first.` });
            await checkStuck(t, d?.command ?? "the merge", moved ? "kept finding that main had moved before it could land" : "kept waiting for the shared lock, which other checks held", d?.output ?? "");
            return { outcome: "check_stuck", delivered: null, detail: r.detail };
          }
          const pause = LOCK_RETRY_BASE_MS * 2 ** (attempt - 1);
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `${LOCK_RETRY_TEXT} (try ${attempt} of ${LOCK_RETRY_ATTEMPTS}, next in ${Math.max(1, Math.round(pause / 60_000))} min). Nothing failed; no need to run it by hand.` });
          const beat = setInterval(() => void beatNow(ticketId).catch(() => undefined), MERGE_ACTIVITY_MS);
          beat.unref?.();
          try {
            await new Promise((resolve) => setTimeout(resolve, pause));
          } finally {
            clearInterval(beat);
          }
          // Approval can be withdrawn while we wait: don't merge something no longer in review.
          const [now] = await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, ticketId));
          if (now?.state !== "review" || (await leftLineSince(db, ticketId, begun))) return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while the merge check waited, so it was not retried." } };
          if (deps.isLeader && !deps.isLeader()) return { outcome: "check_stuck", delivered: null, detail: { note: "Handed over while the merge waited; the server now in charge restarts it." } };
        }
      } catch (caught) {
        const err = caught instanceof Error ? caught : new Error(String(caught));
        // Any failure counts, not only ReviewError: a database or git exception would otherwise leave an approved ticket with no record and no card.
        // The approval is already recorded, so nothing else would move the ticket: say so on it and ask the owner as well.
        const [t] = await db.select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ticketId));
        if (!t) throw err;
        // A sign-off that arrived while the merge ran is the owner's next answer, not a failed merge: no card (BOS-471).
        if (isSignoffPending(err)) {
          await lineEvent(db, t, { event: "hold_started", hold: "sign_off" });
          throw err;
        }
        // A reviewer's hold (BOS-808) is a wait too: no failure trail, no merge card.
        if (err instanceof ReviewHeldError) throw err;
        // Handed over mid-merge (a deploy swapped the server copies): the copy now in charge tries again by itself.
        if (deps.isLeader && !deps.isLeader()) {
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_failed", summary: `The merge was cut off when the server handed over (${err.message}); the server now in charge will try again.` });
          throw err;
        }
        if (gitTwice) {
          // BOS-1860: the retry after a push/fetch failure failed on the network too. One merge card, on the CEO's rung of the
          // alert ladder (the CEO retries gate faults first); it reaches the owner only if the CEO hasn't settled it in time.
          await failed("git_transport", undefined, err.message);
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_failed", summary: `Approved, but the merge couldn't reach the git host twice (${err.message.slice(0, 300)}); a merge card is with the CEO.` });
          const raised = await raiseMergeStuck(db, t, `it couldn't reach the git host twice, 30 s apart: ${err.message}`, { ceoFirst: { why: "a push or fetch to the git host failed twice; the CEO retries gate faults first" } });
          await setGitNote(ticketId, GIT_RETRY_CARD_NOTE).catch(() => undefined);
          if (raised.length) await tellCeo(t, "decision", `"${t.title}" was approved, but its merge couldn't reach the git host twice, 30 s apart (a network fault, not the agent's work). The merge card is yours first: check githubstatus.com or the runner's network, then answer "${CHECK_AGAIN}" on card ${raised[0]!.id} once the git host answers again.`).catch(() => undefined);
          throw err;
        }
        await failed("gate_fault", undefined, err.message);
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_failed", summary: `Approved, but the merge couldn't run: ${err.message}` });
        await mergeStuck(t, err.message);
        // Whoever approved still hears why, as before.
        throw err;
      } finally {
        // BOS-1860: the retry is over, whichever way it ended: the note no longer says "retrying". A card's own flag stays.
        if (gitRetried) await setGitNote(ticketId, null, [GIT_RETRY_NOTE]).catch(() => undefined);
      }
    },

    /**
     * A ticket just merged: start the merge again on every approved ticket the carried-work gate held for it
     * (BOS-733). Without this they sat in review until someone happened to approve again, since the sweep's one
     * retry was long spent. The hold names its tickets by title (kept apart from the sentence, BOS-819), so a
     * same-titled ticket may be retried for nothing; that is harmless, as the gate runs again in full and refuses
     * again if it must.
     */
    /**
     * Ends every hold Boss Man releases by itself whose waits are merged and live, and starts those merges again
     * (BOS-1173). Called after a merge and by the sweep, which catches the deploy or runner rebuild that makes a fix live.
     */
    async releaseHolds(ticketId?: string): Promise<string[]> {
      if (deps.isLeader && !deps.isLeader()) return [];
      return releaseReadyHolds(db, (id) => this.startLanding(id, "Boss Man (what this merge waited on is merged and live)"), ticketId);
    },

    /**
     * The head a passed round approved (BOS-1173): the one head its approvals were stamped with, or, for a round from
     * before heads were kept, the owner's standing sign-off on it when that came after the round. Null when unknown.
     */
    async passedHead(t: typeof tickets.$inferSelect, rows: ReviewRow[]): Promise<string | null> {
      const approved = rows.filter((r) => r.status === "approved");
      const heads = [...new Set(approved.map((r) => r.head).filter((h): h is string => !!h))];
      if (heads.length === 1 && approved.every((r) => r.head)) return heads[0]!;
      if (heads.length) return null;
      const since = Math.max(...rows.map((r) => (r.decidedAt ?? r.createdAt).getTime()));
      const prior = await priorSignoff(db, t, null);
      return prior.current?.head && new Date(prior.current.at).getTime() >= since ? prior.current.head : null;
    },

    /**
     * BOS-1647: the push to the default branch landed but the merge was never recorded (the runner or server was cut off
     * between the two, or the ticket left review before a retry). When the ticket's approved head is already inside the
     * default branch, records the merge with the commit that brought it in, exactly as a merge that finished would: no new
     * merge attempt, no push, no bounce. Null when the ticket isn't in that state (head not on main, not approved on this
     * head, uncommitted work, already done), so the caller carries on as before. `known` is a diff the caller just read.
     */
    async recordLanded(ticketId: string, causedByRunId?: string | null, known?: WorkspaceDiff | null): Promise<{ outcome: "merged"; delivered: string | null; detail?: unknown } | null> {
      const { t, repoUrl, landing } = await ticketWithRepo(ticketId);
      if (t.systemState === "done" || !repoUrl || !t.branch || t.noCode || landing === "pull_request") return null;
      const rows = await latestRows(db, ticketId);
      if (!rows.length || evaluate(rows) !== "passed") return null;
      const changed = known === undefined ? await this.diff(ticketId).catch(() => null) : known;
      const into = changed?.mergedInto;
      if (!changed || !into || changed.files.length) return null;
      // Only the head the reviews passed: a head that merely sits on main (a branch never worked on) is not this ticket's merge.
      const passed = await this.passedHead(t, rows);
      if (passed && passed !== changed.head) return null;
      // The record a finished merge writes: the commit, when it merged, what it touched. A fast-forward has no file list
      // here, so it counts as touching the runner (the safe side, as for any merge with an unknown file list).
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_recorded", summary: `The branch head ${changed.head.slice(0, 8)} was already in the default branch (merged as ${into.commit.slice(0, 8)}) but the merge had not been recorded; recorded now, nothing was pushed.` });
      return closeAfterMerge(t, into.commit, causedByRunId, into.files);
    },

    /**
     * Whether a round already passed this branch head as it is now (BOS-1173): the same commit, or one that only took
     * clean merges of main since (DR-038). Null when it can't be told (no passed head, the runner didn't answer).
     */
    async passedThisHead(t: typeof tickets.$inferSelect, rows: ReviewRow[]): Promise<{ head: string; how: string } | null> {
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
    },

    /**
     * A ticket moved into review (BOS-1173, DR-053 point 6): true when its last round already passed this exact code,
     * so that round's approvals and the owner's sign-off stand and no new round is opened. The merge then goes on as
     * for any approved ticket (held if it waits on a fix). False opens a new round, as before, whenever anything is
     * unknown or changed.
     */
    async keptRound(ticketId: string): Promise<boolean> {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t || t.systemState !== "review") return false;
      const rows = await latestRows(db, ticketId);
      const same = await this.passedThisHead(t, rows);
      if (!same) return false;
      await record(db, { companyId: t.companyId, ticketId, kind: "review_kept", summary: `Back in review on ${same.head.slice(0, 8)}, which round ${rows[0]!.round} already passed (${same.how}), so those approvals and any sign-off stand and no new review round was opened.` });
      if (await approvedAndWaiting(ticketId)) await this.startLanding(ticketId, "Boss Man (back in review on code its reviews already passed)").catch(() => undefined);
      return true;
    },

    /**
     * A round opened on code an earlier round already passed, with no verdict in it yet (BOS-1173): it is withdrawn, so
     * nobody reviews the same code again, and the merge goes on from the earlier pass. Rounds with any verdict are left
     * to finish. Each ticket's round is judged once per server run (`judged`), so a changed head isn't asked about again.
     */
    async withdrawRepeatRounds(judged: Set<string>): Promise<string[]> {
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
    },

    async retryHeldBy(mergedId: string): Promise<string[]> {
      if (deps.isLeader && !deps.isLeader()) return [];
      const [m] = await db.select({ title: tickets.title, projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, mergedId));
      if (!m) return [];
      const held = await db
        .select({ id: tickets.id, companyId: tickets.companyId, note: tickets.pullRequestNote })
        .from(tickets)
        .where(and(eq(tickets.projectId, m.projectId), eq(tickets.systemState, "review"), ne(tickets.id, mergedId), sql`${tickets.pullRequestNote} like 'Waiting: its branch also carries %'`));
      const started: string[] = [];
      for (const h of held) {
        if (!carriedTitles(h.note).includes(m.title)) continue;
        // The owner's "merge that one first" card has done its job once every ticket it names has merged.
        await clearCarriedCards(db, h.id, { by: "system", note: `"${m.title}" has merged.`, at: new Date().toISOString() });
        if (!(await approvedAndWaiting(h.id))) continue;
        // startLanding refuses one already running and an open sign-off; either way there is nothing to start here.
        const ok = await this.startLanding(h.id, `Boss Man (the ticket it waited for, "${m.title}", has merged)`).then(() => true, () => false);
        if (!ok) continue;
        started.push(h.id);
        await record(db, { companyId: h.companyId, ticketId: h.id, kind: "merge_retried", summary: `"${m.title}" merged, so the merge this ticket was waiting for was started again. Nothing to do.` });
      }
      return started;
    },

    /**
     * Refuses a merge the owner hasn't signed off when the policy needs it (BOS-503, DR-021). `head` null: any
     * recorded sign-off for this round will do (the early check); a string: the sign-off must cover that commit,
     * and "" (the runner couldn't say) passes only an owner's own approval, which covers what is there now.
     */
    async requireSignoff(t: typeof tickets.$inferSelect, head: string | null, because?: string) {
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
    },

    // BOS-1902: one merge attempt (landOnce, mergePullRequest) lives in merge-attempt.ts; each delegate passes the service as `this`.
    landOnce(...a: Rest<typeof landOnce>) { return landOnce.call(this, ctx, ...a); },
    mergePullRequest(...a: Rest<typeof mergePullRequest>) { return mergePullRequest.call(this, ctx, ...a); },

    /**
     * Tells someone when a waiting pull request's checks change (R86): a failure goes to the
     * assignee, who is sent back to fix it; a pass goes to the CEO, who can see why it hasn't
     * merged. Each head commit and result is told once.
     */
    async notifyChecks(ticketId: string) {
      const { t, repoUrl, gitHost, gitApiBase } = await ticketWithRepo(ticketId);
      if (!t.pullRequestHead || !t.pullRequestNumber || t.systemState !== "review") return;
      const { cfg, token } = await prTarget(t.companyId, repoUrl, gitHost, gitApiBase);
      const c = await deps.gitHosts!.checks(cfg, token, t.pullRequestHead);
      const key = `${t.pullRequestHead}:${c.state}`;
      if ((c.state !== "failed" && c.state !== "passed") || key === t.pullRequestCi) return;
      await db.update(tickets).set({ pullRequestCi: key }).where(eq(tickets.id, ticketId));
      await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: t.pullRequestHead, kind: "ci", passed: c.state === "passed", detail: c.state === "failed" ? c.failing.join(", ") || null : null });
      if (c.state === "failed" && t.assigneeAgentId) {
        await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
        await tellAgent({ ...t, systemState: "in_progress" }, `The checks on your pull request ${t.pullRequestUrl ?? ""} failed: ${c.failing.join(", ") || "see the host"}. Fix them, push, then move the ticket back to review.`, "ci failed");
      }
      if (c.state === "passed") {
        const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
        if (ceo) await reviewState.wake?.(ceo.id, { ticketId, reason: "ci passed", note: `The checks passed on the pull request for "${t.title}", but it hasn't merged: ${t.pullRequestNote ?? "the host hasn't said why"}. Move it forward.` });
      }
    },

    /**
     * DR-009 #5 (BOS-575): a merged ticket closed with an after-merge check at fail, so the live work doesn't
     * do what it should. Boss Man opens the follow-up itself, so it is never a bare title nobody owns (BOS-542):
     * what failed and what was reported, the merged ticket's project, risk and feature, its assignee (the CEO
     * when it has none), the failed checks as its criteria, and a link each way. The CEO is told. Returns the
     * new ticket, or null when nothing failed.
     */
    async followUpFailedChecks(ticketId: string, failed: string[], reported: string, byAgentId: string | null) {
      if (!failed.length) return null;
      const [row] = await db.select({ t: tickets, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, ticketId));
      if (!row) return null;
      const { t, prefix } = row;
      const ref = ticketRef(prefix, t.number) ?? `"${t.title}"`;
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
      const assigneeAgentId = t.assigneeAgentId ?? ceo?.id ?? null;
      // This path never makes an unowned ticket: with nobody to give it to, the caller says so instead.
      if (!assigneeAgentId) return null;
      const many = failed.length > 1;
      const title = (many ? `Follow-up to ${ref}: ${failed.length} after-merge checks failed on the live work` : `Follow-up to ${ref}: ${failed[0]}`).slice(0, 200);
      const body = [
        `**Why:** ${ref} ("${t.title}") merged${t.mergeCommit ? ` as ${t.mergeCommit.slice(0, 12)}` : ""}, and ${many ? "these checks" : "this check"} failed once the work was live:`,
        ...failed.map((c) => `- ${c}`),
        "",
        `**What was reported:** ${reported.replace(/\s+/g, " ").trim().slice(0, 1500) || "(nothing)"}`,
        "",
        `**Do:** find why ${many ? "they fail" : "it fails"} on the live work, fix it on this ticket's branch, and show ${many ? "them" : "it"} passing once merged. The merged ticket, with its description and conversation: [${ref}](#/tickets/${t.id}).`,
        "",
        "Opened by Boss Man when the merged ticket closed with this check at fail (DR-009 #5, BOS-575).",
      ].join("\n");
      const made = await deps.work.createTicket(t.projectId, {
        title,
        body,
        risk: t.risk ?? "medium",
        state: "ready",
        overLimit: true,
        assigneeAgentId,
        featureId: t.featureId,
        milestoneId: t.milestoneId,
        urgent: t.urgent,
        acceptanceCriteria: failed.map((text) => ({ text, after: "merge" as const })),
        createdByAgentId: byAgentId,
      });
      // The number is set by a database trigger; read it back rather than trust the insert's row.
      const [numbered] = await db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, made.id));
      const newRef = ticketRef(prefix, numbered?.number) ?? `"${made.title}"`;
      const link = `Follow-up: ${newRef} (#/tickets/${made.id}), for ${many ? "the failed after-merge checks" : "the failed after-merge check"}.`;
      const [now] = await db.select({ note: tickets.stateNote }).from(tickets).where(eq(tickets.id, t.id));
      await db
        .update(tickets)
        .set({ stateNote: `${(now?.note ?? "").trim()}${now?.note?.trim() ? " " : ""}${link}`.slice(0, 4000) })
        .where(eq(tickets.id, t.id));
      await record(db, { companyId: t.companyId, ticketId: t.id, agentId: byAgentId, kind: "follow_up", summary: link, detail: { followUpTicketId: made.id, failed } });
      const [who] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, assigneeAgentId));
      await tellCeo(made, "follow-up created", `${ref} ("${t.title}") closed with ${many ? "after-merge checks" : "an after-merge check"} at fail, so Boss Man opened ${newRef} "${made.title}" for ${who?.name ?? "nobody"}, risk ${made.risk ?? "medium"}, with the failed ${many ? "checks" : "check"} as its criteria. Re-assign or re-rate it if that's wrong; otherwise nothing to do.`).catch(() => undefined);
      return { id: made.id, ref: newRef, title: made.title, assignee: who?.name ?? null };
    },

    /** Checks every ticket waiting on a pull request: merged on the host, or mergeable now. */
    async syncPullRequests() {
      const waiting = await db.select({ id: tickets.id }).from(tickets).where(and(isNotNull(tickets.pullRequestNumber), eq(tickets.systemState, "review")));
      let merged = 0;
      for (const w of waiting) {
        const r = await this.mergePullRequest(w.id).catch(() => null);
        if (r?.outcome === "merged") merged++;
        else if (r) await this.notifyChecks(w.id).catch(() => undefined);
      }
      return { checked: waiting.length, merged };
    },

    templates,

    checkMergedResult,
    async setCheckMergedResult(on: boolean) {
      await db.insert(settings).values({ key: CHECK_MERGED_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
      return on;
    },

    /**
     * BOS-1749: deletes bossman-ci/* branches on each GitHub project's repo whose commit is older than `maxAgeMs` and whose ticket
     * has no CI wait running here. Catches what the gate's own cleanup missed (a restart mid-check, a refused delete). Only
     * branches named bossman-ci/ are ever listed or deleted (git-hosts.ts). Repos and tokens come from the projects themselves.
     */
    async sweepCiBranches(maxAgeMs = 6 * 3_600_000): Promise<{ repos: number; deleted: string[]; failed: number }> {
      const out = { repos: 0, deleted: [] as string[], failed: 0 };
      if (!deps.gitHosts) return out;
      const rows = await db.select({ companyId: projects.companyId, repoUrl: projects.repoUrl, gitHost: projects.gitHost, gitApiBase: projects.gitApiBase }).from(projects).where(eq(projects.gitHost, "github"));
      const seen = new Set<string>();
      for (const p of rows) {
        const target = await prTarget(p.companyId, p.repoUrl, p.gitHost, p.gitApiBase).catch(() => null);
        if (!target) continue;
        const key = `${target.cfg.apiBase}/${target.cfg.owner}/${target.cfg.repo}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.repos++;
        try {
          for (const b of await deps.gitHosts.ciBranches(target.cfg, target.token)) {
            if (Date.now() - b.committedAt < maxAgeMs || ciWaits.has(b.branch.slice(CI_BRANCH_PREFIX.length))) continue;
            if (await deps.gitHosts.deleteCiBranch(target.cfg, target.token, b.branch)) out.deleted.push(b.branch);
            else out.failed++;
          }
        } catch {
          out.failed++;
        }
      }
      return out;
    },

    waitForCi,
    async setWaitForCi(on: boolean) {
      await db.insert(settings).values({ key: WAIT_FOR_CI_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
      return on;
    },

    mergeCarry,
    async setMergeCarry(on: boolean) {
      await db.insert(settings).values({ key: MERGE_CARRY_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
      return on;
    },

    mergeRetarget,
    async setMergeRetarget(on: boolean) {
      await db.insert(settings).values({ key: MERGE_RETARGET_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
      return on;
    },

    mergeTurnMinutes,
    async setMergeTurnMinutes(minutes: number) {
      const value = Math.max(0, Math.min(Math.floor(minutes), MERGE_TURN_MAX_MIN));
      await db.insert(settings).values({ key: MERGE_TURN_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return value;
    },

    async setTemplates(companyId: string, patch: Partial<GitTemplates>) {
      const next = { ...(await templates(companyId)), ...patch };
      await db.insert(settings).values({ key: `git_templates:${companyId}`, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } });
      return next;
    },

    /** Asks the agent to commit, or to push and open a PR, using the company's templates. */
    async gitAction(ticketId: string, action: "commit" | "pr") {
      const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
      if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo.");
      const tpl = (await templates(t.companyId))[action];
      const text = renderTemplate(tpl, { branch: t.branch ?? `bossman/${t.id}`, base_ref: defaultBranch, ticket: t.title });
      return { delivered: await tellAgent(t, text, action === "pr" ? "open pr" : "commit"), message: text };
    },
  };
}
