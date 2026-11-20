// Review (R39): the review state carries the ticket's diff against its base, line comments
// go back to the agent as one message, and commit and PR steps are prompts from templates
// the owner can edit. Approving finishes the ticket until the merge step (R46) exists.
import type { Db } from "../db/client.js";

// BOS-1901 (BOS-1886 plan): region A lives in review-common.ts and the closure's state and helpers in review-ctx.ts. Every name
// review.ts exported before is re-exported here, so callers keep importing review.ts.
export { BOUNCE_RECORD_MAX, checkNeverFinished, checkQueueStuck, checkWaitedForLock, CI_TIMING, ciBounceRecord, FLAKE_RERUN_MAX_MS, FULL_CHECK_NEXT, gateBounceRecord, highestRisk, INFRA_CAUSE_TEXT, INFRA_RETRY_ATTEMPTS, INFRA_RETRY_BASE_MS, isSignoffPending, landingText, LOCK_RETRY_ATTEMPTS, LOCK_RETRY_BASE_MS, LOCK_RETRY_TEXT, MERGE_ACTIVITY_MS, MERGE_CARRY_KEY, MERGE_RETARGET_KEY, MERGE_TURN_DEFAULT_MIN, MERGE_TURN_KEY, MERGE_TURN_MAX_MIN, MERGE_WAIT_MS, NOTHING_CHANGED, ReviewError, ReviewHeldError, RUNNER_WAIT_MS, setInfraRetryBase, setLockRetryBase, SignoffPendingError } from "./review-common.js";
export type { GitTemplates, HoldActor, HoldInput, InfraCause, LandingStatus, LandingView, LandOptions } from "./review-common.js";
import type { NotifyHook } from "./review-common.js";
import { reviewContext, type ReviewDeps, type Rest } from "./review-ctx.js";
import { cancelHold, holdActorCheck, markLive, moveAfterMerge, releaseGoLiveWaiters, releaseHold } from "./review-hold-actions.js";
import { landOnce, mergePullRequest } from "./merge-attempt.js";
import { approve, diff, keptRound, landApproved, migrations, needsChanges, noteRead, overrule, passedHead, passedThisHead, readFile, reAskChangesRequested, requireSignoff, reviewStall, sendBack, sendBackRound, sequence, settle, signoffCovers, signoffStale, submit, withdrawRepeatRounds, withdrawStaleSignoff } from "./review-rounds.js";
import { afterLandingSweep, claimLanding, land, landVisible, recordLanded, releaseHolds, retryHeldBy, retryMerge, startLanding } from "./merge-land.js";
import { branchChecks, branchChecksLine, branchChecksOrThrow, branchClash, followUpFailedChecks, gitAction, landing, landingActive, landingMergeIds, landingMergesByCompany, mergeLineClashes, mergeState, notifyChecks, recordMissedMerge, recordMissedMerges, runningMerges, setCheckMergedResult, setMergeCarry, setMergeRetarget, setMergeTurnMinutes, setTemplates, setWaitForCi, sweepCiBranches, syncPullRequests } from "./merge-status.js";

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
  const { state: reviewState, gate, checkMergedResult, waitForCi, mergeCarry, mergeRetarget, mergeTurnMinutes, templates, ownerSignoffOpen } = ctx;

  return {
    setWakeHook(hook: NotifyHook) {
      reviewState.wake = hook;
    },

    /** Whether the owner's sign-off card for this ticket is still open, so a press can settle it first (BOS-471). */
    ownerSignoffOpen,

    // BOS-1904: review rounds and verdicts live in review-rounds.ts, the landing start and retry loop in merge-land.ts, and
    // merge status and upkeep in merge-status.ts; each delegate passes the service as `this`.
    diff(...a: Rest<typeof diff>) { return diff.call(this, ctx, ...a); },
    noteRead(...a: Rest<typeof noteRead>) { return noteRead.call(this, ctx, ...a); },
    migrations(...a: Rest<typeof migrations>) { return migrations.call(this, ctx, ...a); },
    needsChanges(...a: Rest<typeof needsChanges>) { return needsChanges.call(this, ctx, ...a); },
    readFile(...a: Rest<typeof readFile>) { return readFile.call(this, ctx, ...a); },
    submit(...a: Rest<typeof submit>) { return submit.call(this, ctx, ...a); },
    settle(...a: Rest<typeof settle>) { return settle.call(this, ctx, ...a); },
    approve(...a: Rest<typeof approve>) { return approve.call(this, ctx, ...a); },
    landApproved(...a: Rest<typeof landApproved>) { return landApproved.call(this, ctx, ...a); },
    sendBackRound(...a: Rest<typeof sendBackRound>) { return sendBackRound.call(this, ctx, ...a); },
    reAskChangesRequested(...a: Rest<typeof reAskChangesRequested>) { return reAskChangesRequested.call(this, ctx, ...a); },
    sequence(...a: Rest<typeof sequence>) { return sequence.call(this, ctx, ...a); },
    overrule(...a: Rest<typeof overrule>) { return overrule.call(this, ctx, ...a); },
    retryMerge(...a: Rest<typeof retryMerge>) { return retryMerge.call(this, ctx, ...a); },

    // BOS-1901: the hold and go-live actions live in review-hold-actions.ts; each delegate passes the service as `this`.
    holdActorCheck(...a: Rest<typeof holdActorCheck>) { return holdActorCheck.call(this, ctx, ...a); },
    releaseHold(...a: Rest<typeof releaseHold>) { return releaseHold.call(this, ctx, ...a); },
    cancelHold(...a: Rest<typeof cancelHold>) { return cancelHold.call(this, ctx, ...a); },
    releaseGoLiveWaiters(...a: Rest<typeof releaseGoLiveWaiters>) { return releaseGoLiveWaiters.call(this, ctx, ...a); },
    markLive(...a: Rest<typeof markLive>) { return markLive.call(this, ctx, ...a); },
    moveAfterMerge(...a: Rest<typeof moveAfterMerge>) { return moveAfterMerge.call(this, ctx, ...a); },

    landing(...a: Rest<typeof landing>) { return landing.call(this, ctx, ...a); },
    mergeState(...a: Rest<typeof mergeState>) { return mergeState.call(this, ctx, ...a); },
    branchChecks(...a: Rest<typeof branchChecks>) { return branchChecks.call(this, ctx, ...a); },
    branchChecksOrThrow(...a: Rest<typeof branchChecksOrThrow>) { return branchChecksOrThrow.call(this, ctx, ...a); },
    branchChecksLine(...a: Rest<typeof branchChecksLine>) { return branchChecksLine.call(this, ctx, ...a); },

    /** The in-memory merge gate's checks: running and waiting (BOS-420 counts them before a server update). */
    gateState: () => gate.state(),
    /** Looks at the gate's queue again now: a server update's soft hold lifted (BOS-420). */
    gatePump: () => gate.pump(),

    runningMerges(...a: Rest<typeof runningMerges>) { return runningMerges.call(this, ctx, ...a); },
    landingMergesByCompany(...a: Rest<typeof landingMergesByCompany>) { return landingMergesByCompany.call(this, ctx, ...a); },
    landingMergeIds(...a: Rest<typeof landingMergeIds>) { return landingMergeIds.call(this, ctx, ...a); },
    recordMissedMerges(...a: Rest<typeof recordMissedMerges>) { return recordMissedMerges.call(this, ctx, ...a); },
    recordMissedMerge(...a: Rest<typeof recordMissedMerge>) { return recordMissedMerge.call(this, ctx, ...a); },
    landingActive(...a: Rest<typeof landingActive>) { return landingActive.call(this, ctx, ...a); },
    branchClash(...a: Rest<typeof branchClash>) { return branchClash.call(this, ctx, ...a); },
    mergeLineClashes(...a: Rest<typeof mergeLineClashes>) { return mergeLineClashes.call(this, ctx, ...a); },
    signoffCovers(...a: Rest<typeof signoffCovers>) { return signoffCovers.call(this, ctx, ...a); },
    signoffStale(...a: Rest<typeof signoffStale>) { return signoffStale.call(this, ctx, ...a); },
    withdrawStaleSignoff(...a: Rest<typeof withdrawStaleSignoff>) { return withdrawStaleSignoff.call(this, ctx, ...a); },
    claimLanding(...a: Rest<typeof claimLanding>) { return claimLanding.call(this, ctx, ...a); },
    landVisible(...a: Rest<typeof landVisible>) { return landVisible.call(this, ctx, ...a); },
    afterLandingSweep(...a: Rest<typeof afterLandingSweep>) { return afterLandingSweep.call(this, ctx, ...a); },
    startLanding(...a: Rest<typeof startLanding>) { return startLanding.call(this, ctx, ...a); },
    sendBack(...a: Rest<typeof sendBack>) { return sendBack.call(this, ctx, ...a); },
    reviewStall(...a: Rest<typeof reviewStall>) { return reviewStall.call(this, ctx, ...a); },
    land(...a: Rest<typeof land>) { return land.call(this, ctx, ...a); },
    releaseHolds(...a: Rest<typeof releaseHolds>) { return releaseHolds.call(this, ctx, ...a); },
    passedHead(...a: Rest<typeof passedHead>) { return passedHead.call(this, ctx, ...a); },
    recordLanded(...a: Rest<typeof recordLanded>) { return recordLanded.call(this, ctx, ...a); },
    passedThisHead(...a: Rest<typeof passedThisHead>) { return passedThisHead.call(this, ctx, ...a); },
    keptRound(...a: Rest<typeof keptRound>) { return keptRound.call(this, ctx, ...a); },
    withdrawRepeatRounds(...a: Rest<typeof withdrawRepeatRounds>) { return withdrawRepeatRounds.call(this, ctx, ...a); },
    retryHeldBy(...a: Rest<typeof retryHeldBy>) { return retryHeldBy.call(this, ctx, ...a); },
    requireSignoff(...a: Rest<typeof requireSignoff>) { return requireSignoff.call(this, ctx, ...a); },

    // BOS-1902: one merge attempt (landOnce, mergePullRequest) lives in merge-attempt.ts; each delegate passes the service as `this`.
    landOnce(...a: Rest<typeof landOnce>) { return landOnce.call(this, ctx, ...a); },
    mergePullRequest(...a: Rest<typeof mergePullRequest>) { return mergePullRequest.call(this, ctx, ...a); },

    notifyChecks(...a: Rest<typeof notifyChecks>) { return notifyChecks.call(this, ctx, ...a); },
    followUpFailedChecks(...a: Rest<typeof followUpFailedChecks>) { return followUpFailedChecks.call(this, ctx, ...a); },
    syncPullRequests(...a: Rest<typeof syncPullRequests>) { return syncPullRequests.call(this, ctx, ...a); },

    templates,

    checkMergedResult,
    setCheckMergedResult(...a: Rest<typeof setCheckMergedResult>) { return setCheckMergedResult.call(this, ctx, ...a); },

    sweepCiBranches(...a: Rest<typeof sweepCiBranches>) { return sweepCiBranches.call(this, ctx, ...a); },

    waitForCi,
    setWaitForCi(...a: Rest<typeof setWaitForCi>) { return setWaitForCi.call(this, ctx, ...a); },

    mergeCarry,
    setMergeCarry(...a: Rest<typeof setMergeCarry>) { return setMergeCarry.call(this, ctx, ...a); },

    mergeRetarget,
    setMergeRetarget(...a: Rest<typeof setMergeRetarget>) { return setMergeRetarget.call(this, ctx, ...a); },

    mergeTurnMinutes,
    setMergeTurnMinutes(...a: Rest<typeof setMergeTurnMinutes>) { return setMergeTurnMinutes.call(this, ctx, ...a); },

    setTemplates(...a: Rest<typeof setTemplates>) { return setTemplates.call(this, ctx, ...a); },
    gitAction(...a: Rest<typeof gitAction>) { return gitAction.call(this, ctx, ...a); },
  };
}
