// Review (R39): the review state carries the ticket's diff against its base, line comments
// go back to the agent as one message, and commit and PR steps are prompts from templates
// the owner can edit. Approving finishes the ticket until the merge step (R46) exists.
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { gateMergeMessage, isGateMergeOf, MAIN_LOG_MAX, mergeMessageTicket, wakeCeoIfLiveUnplaced } from "./missed-merges.js";
import { deploysNothing, goLiveWaitWords, ownerApprovedFiles, realUseWalkthrough, REAL_USE_REFUSAL, touchesInstallSurface, touchesRunnerCode, touchesRunnerUpdate, usabilityGated } from "@boss-man/shared";
import { goLiveWaitOf, serverIsGoLive } from "./go-live-wait.js";
import { checkFailureFacts, checkFailureSentence, failingLines, FULL_LOG_RETENTION_DAYS, fullLogPointer, redactForModel,criterionText, deepChecks, DEFAULT_GIT_TEMPLATES, formatDate, formatReviewComments, isAfterMerge, movableFailures, MERGE_MISSED_AFTER_MS, parseRepoUrl, carryFailedOver, readCriteria, readVerdicts, renderTemplate, ticketRef, REVIEW_KINDS, RISK_TIERS, riskOf, ruleFor, slotRef, unreportedAfterMerge, type CarriedTicket, type GitHostKind, type MainLogResult, type MergeLineConflictsResult, type MergeResult, type MigrationsResult, type PushResult, type ReviewComment, type ReviewSlot, type RiskTier, type VerifyResult, type WorkspaceDiff, VERIFY_ASK_TIMEOUT_MS } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, checkJobs, checkResults, checkWorkers, companies, decisions, deployTargets, projects, reviewRequests, runners, settings, ticketDependencies, ticketMessages, ticketReviews, tickets } from "../db/schema.js";
import { addTicketDependency, openHoldingCard } from "./ticket-links.js";
import type { runnersService } from "./runners.js";
import { RunnerGone } from "./runners.js";
import type { workService } from "./work.js";
import { DIFFERENT_APPROACH, type loopGuards } from "./loop-guards.js";
import { CI_TIMING, CiPublishError, ciStops, publishAndWait as ciPublishAndWait, type CiOutcome, type CiStop } from "./ci-publish.js";
import { GitHostError, type CiStatus, type CommitChecks, type GitHostConfig, type gitHostService } from "./git-hosts.js";
import { effectivePolicy, otherReviewers } from "./review-policy.js";
import { activeRows, decide, evaluate, latestRows, recordReviewWait, reviveSkipped, setReviewOrder, skipPending, wakeReviewers, type ReviewRow } from "./review-kinds.js";
import { CHECK_AGAIN, CHECK_SEND_BACK, CHECK_SKIP, clearCarriedCards, clearMergeCards, fixesLiveHeading, raiseMergeStuck, REASSIGN_REVIEW, SEND_BACK_FOR_MERGE, supersedeSignoffs, TAKE_REVIEW, WAIT_ANOTHER_HOUR, type DecisionContext } from "./decisions.js";
import { derivedSignoff, openSignoffCard, priorSignoff, raiseSignoffCard, restoreSignoffCard, signoffState, type SignoffCover } from "./signoff.js";
import { checkGate, ticketCheckPriority } from "./check-gate.js";
import { checkQueue, SUPERSEDED_TEXT } from "./check-queue.js";
import { scanListReader, type ScanListWarning } from "./scan-list.js";
import { LESSON_ADD, LESSON_DROP, LESSON_EDIT, LESSON_MAX, lessonsForCeo, normalizeLesson } from "./project-brief.js";
import { record } from "./activity.js";
import { leftLineSince, lineEvent, TRAIN_CLASH_FILES, type CheckWay, type FailReason, type HoldReason } from "./merge-line.js";
import { conflictNote, mergeLineApproved } from "./merge-line-conflicts.js";
import { recordFailedAttempt } from "./merge-failures.js";
import { priorityGroup } from "./priority-group.js";
import { mainGen, mainMoved, trainFor, type RestackWhy, type TrainClash } from "./merge-train.js";
import { closeHold, createHold, ensureSystemHold, mergeHolds, mergeWaits, openHold, releaseReadyHolds, type HoldWaitInput } from "./review-holds.js";
import { CARRIED_NOTE_PREFIX, carriedTitles } from "./merge-queue.js";
import type { notificationsService } from "./notifications.js";

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** True when asking again could work (the runner was busy or silent), as opposed to a host that is not set up. */
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** What the owner sees while and after an approval lands (B): in plain words. */
export type LandingStatus = { state: "running"; startedAt: string; command: string | null; startedBy: string } | { state: "finished"; outcome: string; text: string; url: string | null; finishedAt: string };
/**
 * A running landing as the page sees it. `stale` means the ticket has gone quiet for longer than a
 * merge can take (the same heartbeat the unmerged-approvals sweep watches), so the marker is a
 * leftover and the owner may start it again rather than waiting forever.
 */
export type LandingView = (LandingStatus & { stale?: boolean; phase?: "queued" | "checking" | "merging" | "waiting_to_retry" }) | null;

/**
 * A check that was killed or timed out says nothing about the agent's work (the runner ran out of
 * memory, say), so it goes to the owner instead of back to the agent. Why it ended, or null if it
 * simply failed.
 */
export function checkNeverFinished(v: { timedOut: boolean; exitCode: number | null; output: string }): "timed_out" | "out_of_memory" | "killed" | null {
  const tail = v.output.slice(-4000);
  if (v.timedOut) return "timed_out";
  if (/JavaScript heap out of memory|out of memory|ENOMEM|Cannot allocate memory/i.test(tail)) return "out_of_memory";
  if (v.exitCode === 137 || v.exitCode === 143 || v.exitCode === null || /\bSIGKILL\b|\bKilled\b|Worker exited unexpectedly/i.test(tail)) return "killed";
  return null;
}

/**
 * True when the check gave up only because it waited too long for the shared heavy-phase lock:
 * scripts/check-all.sh exits 75 with this wording before any step runs, so nothing the agent wrote failed.
 */
export function checkWaitedForLock(v: { exitCode: number | null; output: string }): boolean {
  return v.exitCode === 75 && /check-all: gave up waiting for the heavy-phase lock/.test(v.output) && !checkQueueStuck(v);
}
/**
 * True when the queue itself stood still (BOS-370): a merge check keeps its place while the queue moves, and gives up
 * only when its place and the slot holders have not changed for longer than a check runs. Retrying would only wait
 * again, so the owner is told at once.
 */
export function checkQueueStuck(v: { exitCode: number | null; output: string }): boolean {
  return v.exitCode === 75 && /check-all: gave up waiting for the heavy-phase lock[^\n]*the queue made no progress for (\d+) min/.test(v.output);
}
/** Tries a merge check that only timed out on the lock this many times, pausing LOCK_RETRY_BASE_MS, then double, between them. */
export const LOCK_RETRY_ATTEMPTS = 6;
// shortcut: a constant except for tests, which lower it through setLockRetryBase; no per-request state.
export let LOCK_RETRY_BASE_MS = 60_000;
/** For tests. */
export const setLockRetryBase = (ms: number) => { LOCK_RETRY_BASE_MS = ms; };
export const LOCK_RETRY_TEXT = "Merge check waiting for lock, retrying";

/**
 * A merge check that died from the host, not the code (killed, out of memory, timed out, or the runner never
 * answered) is run again by itself this many times, pausing INFRA_RETRY_BASE_MS, then double, between them (BOS-446).
 * The last try runs alone, with no other merge check beside it. Only after that does a card appear, for the CEO.
 * checkNeverFinished is the one list of such causes; "the runner didn't answer" is added by the caller.
 */
export const INFRA_RETRY_ATTEMPTS = 3;
// shortcut: a constant except for tests, which lower it through setInfraRetryBase; no per-request state.
export let INFRA_RETRY_BASE_MS = 30_000;
/** For tests. */
export const setInfraRetryBase = (ms: number) => { INFRA_RETRY_BASE_MS = ms; };
export type InfraCause = "timed_out" | "out_of_memory" | "killed" | "no_answer";
export const INFRA_CAUSE_TEXT: Record<InfraCause, (ms: number) => string> = {
  timed_out: (ms) => `timed out after ${Math.max(1, Math.round(ms / 60_000))} min`,
  out_of_memory: () => "ran out of memory",
  killed: () => "was killed",
  no_answer: () => "got no answer from the runner",
};

/** How long the server waits for the runner to merge or push an approved branch. */
export const MERGE_WAIT_MS = 10 * 60_000;
/** Set for the project check when the deeper check runs straight after it on the same tree (BOS-665); scripts/check-quick.sh reads it. */
export const FULL_CHECK_NEXT = "BOSSMAN_FULL_CHECK_NEXT";
/** How often a landing re-reads its check job row (BOS-316). Tests shorten it with BOSSMAN_CHECK_JOB_POLL_MS. */
/** BOS-1344: how often a waiting merge looks for a moved main. Tests shorten it with BOSSMAN_MERGE_RETARGET_MS. */
const MERGE_RETARGET_MS = Number(process.env.BOSSMAN_MERGE_RETARGET_MS) > 0 ? Number(process.env.BOSSMAN_MERGE_RETARGET_MS) : 60_000;
/** The owner's off switch for refreshing a waiting merge (setting merge_retarget; on unless set to false). */
export const MERGE_RETARGET_KEY = "merge_retarget";
const CHECK_JOB_POLL_MS = Number(process.env.BOSSMAN_CHECK_JOB_POLL_MS) > 0 ? Number(process.env.BOSSMAN_CHECK_JOB_POLL_MS) : 3000;
/**
 * BOS-1515 (B2): a ticket waiting in the merge train tries a merge on main (read-only) when main has moved since its last try,
 * at most once per TRAIN_TRIAL_MIN_MS (each try holds the project's repo lock for a fetch and a merge-tree), and at least every
 * TRAIN_TRIAL_FALLBACK_MS for merges made outside Boss Man. Tests shorten the first with BOSSMAN_TRAIN_TRIAL_MIN_MS.
 */
const TRAIN_TRIAL_MIN_MS = Number(process.env.BOSSMAN_TRAIN_TRIAL_MIN_MS) > 0 ? Number(process.env.BOSSMAN_TRAIN_TRIAL_MIN_MS) : 30_000;
const TRAIN_TRIAL_FALLBACK_MS = 10 * 60_000;
const CHECK_MERGED_KEY = "check_merged_result";
/** BOS-1070: the owner's switch for waiting on the git host's CI before a merge. Off until they turn it on. */
const WAIT_FOR_CI_KEY = "wait_for_ci";
/** BOS-1070: how the gate waits for CI; moved to ci-publish.ts (BOS-1664) and kept exported here. */
export { CI_TIMING };
/** How often a landing in progress says it is still active, so a sweep never starts a second one beside it. */
export const MERGE_ACTIVITY_MS = 60_000;
/** How long a merge waits for a runner that is away (a swap: image pull, slow start) before it counts as a failed try. */
export const RUNNER_WAIT_MS = 30 * 60_000;

/** What the author hears when a ticket that needs code changes has none. */
export const NOTHING_CHANGED = "Nothing in the repository changed. Make the change, or ask your CEO or a manager to mark the ticket as not needing code (update_ticket with noCode true) and say why.";

/** The plain-words outcome of landing, for a non-developer. */
export function landingText(r: { outcome: string; detail?: unknown }, ctx: { branch: string; assignee: string | null }): string {
  const d = (r.detail ?? {}) as { timedOut?: boolean; exitCode?: number | null; output?: string; why?: unknown; ms?: number; keptLog?: VerifyResult["keptLog"]; files?: string[]; foreign?: string[]; problems?: string[]; url?: string | null; note?: string; carried?: Array<{ title: string }>; unchecked?: string; afterMerge?: string[] };
  const back = `It's gone back to ${ctx.assignee ?? "the assignee"}`;
  switch (r.outcome) {
    case "merged":
      return `Merged into ${ctx.branch}.` + (d.afterMerge?.length
          ? ` The ticket stays open until ${d.afterMerge.length === 1 ? "this check is" : "these checks are"} shown to work live: ${d.afterMerge.map((c) => `"${c}"`).join(", ")}. ${back} to report ${d.afterMerge.length === 1 ? "it" : "them"}.`
          : "");
    case "done":
      return `Approved; the ticket is done.${d.note ? ` ${d.note}` : ""}`;
    case "pull_request":
      return `${d.url ? `Pull request opened: ${d.url}.` : "Approved."}${d.note ? ` It hasn't merged yet: ${d.note}` : ""}`;
    case "carried":
      return d.unchecked
        ? `Approved, but not merged: Boss Man couldn't check whether the branch carries other tickets' unmerged work (${d.unchecked}), so it didn't merge. The ticket stays in review; approving it again tries the check again.`
        : `Approved, but not merged: its branch also carries unapproved work from ${(d.carried ?? []).map((c) => `"${c.title}"`).join(", ")}. That ticket must merge first; the ticket stays in review.`;
    case "empty":
      return `Approved, but not closed: nothing in the repository changed. ${back} to make the change, or to mark the ticket as not needing code.`;
    case "verify_failed":
      if ((d as { ci?: string }).ci === "failed") {
        const jobs = (d as { jobs?: string[] }).jobs ?? [];
        return `Approved, but not merged: GitHub CI failed on the merged result${jobs.length ? ` (${jobs.join(", ")})` : ""}. ${back} to fix; the failing jobs and tests are in the conversation below.`;
      }
      // BOS-1220: other verify_failed details (a taken migration number) carry no exit code and no log.
      if (d.exitCode === undefined && !d.timedOut && !d.output && Array.isArray(d.why)) return `Approved, but not merged: a migration number is already taken (${d.why.join("; ")}). ${back} to fix; the details are in the conversation below.`;
      return `Approved, but not merged: the check ${d.timedOut ? `timed out after ${Math.max(1, Math.round((d.ms ?? 0) / 60_000))} minutes` : checkFailureSentence(d)}. ${back} to fix; the check's output is in the conversation below.${d.keptLog ? ` ${fullLogPointer(d.keptLog.jobId, d.keptLog.ticketId, d.keptLog.chars)}` : ""}`;
    case "check_stuck":
      return "Approved, but not merged: the check couldn't finish. This isn't a problem with the agent's work; it's in your Decisions.";
    case "conflicts":
      return `Approved, but not merged: the work conflicts with ${ctx.branch} in ${(d.files ?? []).join(", ")}. ${back} to sort out.`;
    case "migration_journal":
      return `Approved, but not merged: the migration journal would make drizzle skip a migration (${(d.problems ?? []).join(" ")}). ${back} to fix.`;
    case "branch_changed":
      return `Approved, but not merged: new code was added to the branch after the approval, so the reviewers haven't seen it. ${back} and the ticket needs a new review.`;
    case "uncommitted":
      if (d.foreign?.length) return `Approved, but not merged: the ticket's copy on the runner holds changes that aren't this ticket's work (${d.foreign.join(", ")}). The CEO has been told; the branch itself is unchanged.`;
      return `Approved, but not merged: some work isn't saved to the branch yet (${(d.files ?? []).join(", ")}). ${back} to commit it.`;
    default:
      return `Approved, but not merged (${r.outcome.replace(/_/g, " ")}).`;
  }
}

/**
 * BOS-1723: a bounce is told to the agent in its wake note, which nobody can read once it is gone; 91 of 171 failed gate
 * checks left nothing readable. So each check bounce also leaves this record in the ticket's conversation: the job id
 * first (agents see only the first 1500 characters of a message), then what failed and the failing lines.
 */
export const BOUNCE_RECORD_MAX = 4000;
const fitLines = (head: string, lines: string[], prefix: string) => {
  let out = head;
  for (const l of lines) {
    if (out.length + prefix.length + l.length + 1 > BOUNCE_RECORD_MAX) break;
    out += `\n${prefix}${l}`;
  }
  return out;
};

export function gateBounceRecord(b: { command: string; why: string; output: string; jobId?: string | null; ticketId: string }): string {
  const facts = checkFailureFacts(b.output);
  const where = b.jobId ? `Job ${b.jobId}; the whole log: tickets check_log, ticketId ${b.ticketId}, jobId ${b.jobId} (kept ${FULL_LOG_RETENTION_DAYS} days).` : "No job id: this check ran outside the check queue, so only these lines were kept.";
  const named = failingLines(b.output);
  const lines = named.length ? named : b.output.trimEnd().split("\n").slice(-10).map((l) => l.slice(0, 300));
  return redactForModel(fitLines(`Merge check bounced: \`${b.command.slice(0, 300)}\` ${b.why}. ${where}${facts ? `\nWhat failed: ${facts}.` : ""}\n${named.length ? "Failing lines:" : "Last lines:"}`, lines, "> "));
}

export function ciBounceRecord(b: { commit: string; target: string; body: string }): string {
  return redactForModel(fitLines(`GitHub CI bounced the merge of this branch with ${b.target} (merge commit ${b.commit.slice(0, 12)}). Failed jobs, with GitHub's job links and the failing lines:`, b.body.split("\n").map((l) => l.slice(0, 400)), ""));
}

/** The highest of several risk tiers; unrated tickets are medium (BOS-130). */
export function highestRisk(risks: Array<RiskTier | null | undefined>): RiskTier {
  return risks.map(riskOf).reduce((a, b) => (RISK_TIERS.indexOf(b) > RISK_TIERS.indexOf(a) ? b : a), "trivial" as RiskTier);
}

/** A ticket whose branch carries unapproved work, and the ticket it waits for (BOS-130). */
type CarriedInfo = CarriedTicket & { title: string; risk: RiskTier | null };

/** What one landing attempt ends with (landOnce). */
type LandOnceResult = { outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted" | "carried" | "migration_journal"; delivered: string | null; detail?: unknown };


/** Narrow on purpose: only the owner's "Merge without the check" uses skipChecks, for one landing. */
/** `adopt` (BOS-1371): a server that took charge picks up a merge whose check job is still live: skip "prepare" and wait on the job for this commit and tree; "finish" still pushes only if that exact tree is what the merge gives now. */
export type LandOptions = { skipChecks?: boolean; adopt?: { commit: string; tree: string } };

/**
 * A merge that can't start because the owner's sign-off card is still open (BOS-471): the ticket waits for
 * that one answer, so it is a normal wait, never a failure and never a merge-retry card.
 */
export class SignoffPendingError extends ReviewError {
  constructor() {
    super(409, "The owner's sign-off for this ticket is still open, so nothing was merged. Approve and merge on the ticket settles that sign-off and merges in one press.");
  }
}

/**
 * A merge that can't start because a reviewer passed the work but holds the merge (BOS-808). Like the sign-off wait it
 * is a normal wait: no failure trail, no retry card.
 */
export class ReviewHeldError extends ReviewError {
  constructor(message = "A reviewer passed this work but is holding the merge, so nothing was merged. Release the hold first (on the ticket page, or the reviewer or the CEO can); it merges after that.") {
    super(409, message);
  }
}

/** The same wait for an open card raised against the ticket (BOS-919, DR-047 point 3): the merge goes ahead once it is answered. */
const cardHeld = (cardId: string) => new ReviewHeldError(`The card ${cardId} raised on this ticket is still open, so nothing was merged. Answer it first; the merge is started again after that.`);

/** What a reviewer asks for with "Passed, hold merge" (BOS-808). */
export type HoldInput = { reason: string; waitsOn: HoldWaitInput[]; releaseAt: Date | null };

/** Who releases or cancels a hold: the holding reviewer, the CEO, or the owner (no agent). */
export type HoldActor = { name: string; agentId?: string | null; isCeo?: boolean };

/** True for the error a landing throws when the owner's sign-off card still holds the ticket. */
export function isSignoffPending(err: unknown): boolean {
  return err instanceof SignoffPendingError;
}

export type GitTemplates = { commit: string; pr: string };
type NotifyHook = (agentId: string, input: { reason: string; note: string; ticketId?: string | null; priority?: number; causedByRunId?: string | null }) => Promise<unknown>;

/** "4 Nov 07:35 UTC", for a sign-off named on a card or event. */
const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${formatDate("en-GB", d, { month: "short", timeZone: "UTC" })} ${iso.slice(11, 16)} UTC`;
};

/** The owner decides what to do with a check that couldn't finish; the ticket stays in review and the loop detector never hears of it. */
async function raiseCheckStuck(db: Db, t: { companyId: string; id: string; title: string }, command: string, reason: string, output: string, own?: { question: string; tier: "owner" | "ceo"; dedupeKey: string }) {
  // A ticket closed while its check was running needs no merge card (BOS-149): read the state
  // again, because the ticket may have been merged or cancelled since this landing began.
  const [latest] = await db.select({ systemState: tickets.systemState }).from(tickets).where(eq(tickets.id, t.id));
  if (!latest || latest.systemState === "done") return;
  // BOS-1070: one card for a whole project's problem (the git token can't read CI). While one is open, others don't add theirs.
  if (own) {
    const [open] = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.status, "open"), eq(decisions.dedupeKey, own.dedupeKey))).limit(1);
    if (open) return null;
  }
  // One open merge card per ticket: this one replaces any older card (BOS-149).
  await clearMergeCards(db, t.id, { by: "system", note: `Replaced by a newer merge card: the check \`${command}\` ${reason}.`, at: new Date().toISOString() });
  const [row] = await db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "question",
      question: own?.question ?? `"${t.title}": the merge check \`${command}\` couldn't finish (it ${reason}). This isn't a problem with the agent's work.`,
      options: [CHECK_AGAIN, CHECK_SEND_BACK, CHECK_SKIP],
      recommendedOption: CHECK_AGAIN,
      // The CEO first (BOS-446): Boss Man has already retried by itself, and the CEO can retry or send it back.
      // A CI access or billing card (BOS-1070) goes to the owner: only they can change the token or the plan.
      tier: own?.tier ?? "ceo",
      dedupeKey: own?.dedupeKey ?? `merge-stuck:${t.id}`,
      context: { type: "check_stuck", ticketId: t.id, command, output: output.slice(-1500) },
    })
    .onConflictDoNothing()
    .returning({ question: decisions.question });
  await lineEvent(db, t, { event: "hold_started", hold: "card", note: `the check ${reason}`.slice(0, 200) });
  return row?.question ?? null;
}

/** A check's result for the merge-line timeline (BOS-769): null when it never finished, so it says nothing of the work. */
function checkVerdict(v: VerifyResult): boolean | null {
  if (v.ok) return true;
  if ((v as { noAnswer?: boolean }).noAnswer || checkWaitedForLock(v) || checkQueueStuck(v) || checkNeverFinished(v)) return null;
  return false;
}

export function reviewService(
  db: Db,
  deps: {
    runners: ReturnType<typeof runnersService>;
    work: ReturnType<typeof workService>;
    loops: ReturnType<typeof loopGuards>;
    /** Pull requests on the git host (R59), with the company's GIT_TOKEN. */
    gitHosts?: ReturnType<typeof gitHostService>;
    gitToken?: (companyId: string) => Promise<string | undefined>;
    notes?: Pick<ReturnType<typeof notificationsService>, "notify">;
    /** False on a standby copy (blue/green): a merge cut off by the hand-over is left to the leader's sweep. */
    isLeader?: () => boolean;
    /** The owner's private-details list for the merge-line scan (BOS-979). A read failure is said once (BOS-1093); pass it through scanListWarning. */
    scanList?: () => Promise<string | null>;
    /** Where a set list that can't be read says so: one warning and one owner notification per failure streak (BOS-1093). */
    scanListWarning?: ScanListWarning;
    /** A ticket's merge commit is on main: frees the tickets that wait on it "until merged" (BOS-989). */
    onMerged?: (ticketId: string) => Promise<unknown>;
    /** BOS-1070: shorter CI waits for tests. */
    ciTiming?: Partial<typeof CI_TIMING>;
    /** Ends a check job with a reason and stops it on the runner if it runs (the check dispatcher's cancel). Used to drop a merge check left over from before a restart. */
    cancelCheck?: (jobId: string, reason: string) => Promise<unknown>;
    /** BOS-1435: checks the company can run at once (runner plus ready check workers); the merge train's seats. Absent: the slots setting. */
    checkCapacity?: (companyId: string) => Promise<number>;
    /** The alert ladder's raise: three failed merges with one reason in 30 minutes raise one CEO alert (BOS-1461). */
    alert?: (input: Record<string, unknown>) => Promise<unknown>;
  },
) {
  let wake: NotifyHook | null = null;
  // shortcut: the missed-merge sweep running now (BOS-1645), so passes never overlap; lost on restart, harmless because a fresh process runs none.
  let missedSweep: Promise<void> | null = null;
  // shortcut: in memory, so a server restart mid-landing forgets the status (the ticket itself is unaffected); upgrade to a column if owners need it to survive restarts.
  const landings = new Map<string, LandingStatus>();
  // At most N merge checks at once, quick or full (BOS-446); the rest wait in order, urgent and arch fixes first.
  const gate = checkGate(db);
  const queue = checkQueue(db);
  // A set list that can't be read says so; an unset one reads as null, silently.
  const scanListWarning = scanListReader({ read: deps.scanList ?? (async () => null), ...deps.scanListWarning });
  // When each ticket's merge last said it was alive (BOS-362). The merge sweep reads this, not the ticket's
  // activity, which chat and chases also bump: talk must not hold a merge retry back, and a running merge must.
  // shortcut: in memory like `landings`; a restart ends every merge, so forgetting it is correct.
  const landingBeat = new Map<string, number>();
  // Where a running merge is: waiting its turn for a check slot, running the check, or merging (DR-014). In memory like `landings`.
  const phases = new Map<string, "queued" | "checking" | "merging" | "waiting_to_retry">();
  // BOS-1070: a merge waiting for the git host's CI, beside its own check (so not a phase): since when, and the jobs still running.
  // shortcut: in memory like `landings`, lost on restart, harmless because a restart ends the wait it describes.
  const ciWaits = new Map<string, { since: number; waiting: string[] }>();
  // Merged trees the git host's CI passed. A merge rebuilt on a moved main with the same tree keeps the pass, as a
  // check-all pass is kept (P11a), so it isn't pushed and waited for again. shortcut: in memory, so a restart waits again.
  const ciPassedTrees = new Set<string>();
  // Tickets held by another ticket's open CI access or billing card in the same project: started again once CI reads work.
  // shortcut: lost on restart, harmless because the unmerged-approvals sweep starts the held tickets again and they rejoin the open card.
  const ciCardWaiting = new Map<string, Set<string>>();
  const ciTiming = { ...CI_TIMING, ...deps.ciTiming };
  const beatNow = (ticketId: string) => {
    landingBeat.set(ticketId, Date.now());
    return db.update(tickets).set({ lastActivityAt: new Date() }).where(eq(tickets.id, ticketId));
  };

  async function ticketWithRepo(ticketId: string, companyId?: string) {
    const [row] = await db
      .select({
        t: tickets,
        repoUrl: projects.repoUrl,
        projectName: projects.name,
        defaultBranch: projects.defaultBranch,
        verifyCommand: projects.verifyCommand,
        deepVerifyCommand: projects.deepVerifyCommand,
        landing: projects.landing,
        gitHost: projects.gitHost,
        gitApiBase: projects.gitApiBase,
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticketId));
    if (!row || (companyId && row.t.companyId !== companyId)) throw new ReviewError(404, "No such ticket.");
    return row;
  }

  /**
   * A read-only trial merge of the ticket's branch on the default branch (the runner's `workspace.clash`: tryMerge on origin's
   * tip, with the gate's BOS-690 migration renumbering, writing nothing). The clashing files (a real clash with no list is []),
   * or null when it merges cleanly or can't be told (no runner, an older runner, a timeout, an error). Null must always read as
   * "carry on": branchClash (BOS-426) and the merge train's waiting trial (BOS-1515) both rely on that.
   */
  async function clashOnMain(t: { id: string; companyId: string; projectId: string }, defaultBranch: string): Promise<string[] | null> {
    try {
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      if (!runner || !deps.runners.isConnected(runner.id) || !deps.runners.can(runner.id, "clash-check")) return null;
      const r = await deps.runners.request<{ clashes?: boolean; files?: string[] }>(runner.id, (requestId) => ({ type: "workspace.clash", requestId, projectId: t.projectId, ticketId: t.id, target: defaultBranch }), 15_000);
      if (typeof r?.clashes !== "boolean") return null;
      return r.clashes ? (Array.isArray(r.files) ? r.files : []) : null;
    } catch {
      return null;
    }
  }

  /** Tickets by id with their refs (BOS-1515: who a train clash was with), in the order given; unknown ids are left out. */
  async function namedTickets(ids: string[]): Promise<Array<{ ticketId: string; ref: string | null; title: string }>> {
    if (!ids.length) return [];
    const rows = await db.select({ id: tickets.id, title: tickets.title, number: tickets.number, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(inArray(tickets.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [{ ticketId: id, ref: ticketRef(r.prefix, r.number), title: r.title }] : [];
    });
  }

  /**
   * True when a running landing's ticket has gone quiet for longer than a merge can take. The ticket's
   * last activity is the heartbeat every landing keeps, so this uses the same sign of life as the sweep.
   */
  async function landingStale(ticketId: string): Promise<boolean> {
    const [row] = await db.select({ state: tickets.systemState, lastActivityAt: tickets.lastActivityAt }).from(tickets).where(eq(tickets.id, ticketId));
    if (!row || row.state !== "review") return true;
    // BOS-1769: a landing whose ticket left review after it started is over, even when the ticket is back in review and the
    // old landing still beats the heartbeat: otherwise its marker refuses every retry and the back-in-review restart.
    const marker = landings.get(ticketId);
    if (marker?.state === "running" && (await leftLineSince(db, ticketId, new Date(marker.startedAt)))) return true;
    return Date.now() - row.lastActivityAt.getTime() > MERGE_MISSED_AFTER_MS;
  }

  /** The host and token for a pull request; without either, approval stops with what to set (R59). */
  async function prTarget(companyId: string, repoUrl: string | null, gitHost: string | null, gitApiBase: string | null): Promise<{ cfg: GitHostConfig; token: string }> {
    const a = repoUrl ? parseRepoUrl(repoUrl) : null;
    if (!deps.gitHosts || !a || (gitHost !== "gitea" && gitHost !== "github") || !gitApiBase)
      throw new ReviewError(409, "Boss Man doesn't know this project's git host, so it can't open a pull request. Set the host in the project's settings, or land work by merging.");
    const token = await deps.gitToken?.(companyId);
    if (!token) throw new ReviewError(409, "Grant the company a GIT_TOKEN secret that can push and open pull requests, then approve again.");
    return { cfg: { kind: gitHost as GitHostKind, apiBase: gitApiBase, owner: a.owner, repo: a.repo }, token };
  }

  /** The project's open tickets that have a branch of their own, other than this one: candidates to be carried (BOS-130). */
  async function otherOpenBranches(t: typeof tickets.$inferSelect) {
    return db
      .select({ ticketId: tickets.id, branch: tickets.branch, title: tickets.title, risk: tickets.risk })
      .from(tickets)
      .where(and(eq(tickets.projectId, t.projectId), ne(tickets.id, t.id), ne(tickets.systemState, "done"), isNotNull(tickets.branch)));
  }

  /**
   * The unmerged commits of other open tickets' branches that this branch carries (BOS-130): the
   * runner works it out from git. This is a safety gate, so it refuses rather than merges when it
   * can't answer: the runner failing or timing out is an error, and a runner too old to do the
   * check falls back to the host's own answer, which refuses when it can't give one either.
   */
  async function carriedBetween(runnerId: string, t: typeof tickets.$inferSelect, defaultBranch: string, gitHost: string | null, gitApiBase: string | null): Promise<CarriedInfo[]> {
    const others = (await otherOpenBranches(t)).filter((o): o is typeof o & { branch: string } => !!o.branch && o.branch !== t.branch);
    if (!others.length) return [];
    let ids: string[];
    let contained = new Set<string>();
    if (deps.runners.can(runnerId, "carried-check")) {
      let r: { carried?: CarriedTicket[] };
      try {
        // The same wait as a merge: the check queues behind other git jobs for the same repo lock.
        r = await deps.runners.request<{ carried?: CarriedTicket[] }>(runnerId, (requestId) => ({
          type: "workspace.carried",
          requestId,
          projectId: t.projectId,
          ticketId: t.id,
          target: defaultBranch,
          branches: others.map((o) => ({ ticketId: o.ticketId, branch: o.branch })),
        }), MERGE_WAIT_MS);
      } catch (err) {
        throw new ReviewError(409, `Couldn't check whether this branch carries other tickets' unmerged work, so it wasn't merged: ${(err as Error).message} Try approving it again.`, true);
      }
      if (!Array.isArray(r.carried)) throw new ReviewError(409, "Couldn't check whether this branch carries other tickets' unmerged work, so it wasn't merged. Try approving it again.", true);
      ids = r.carried.map((c) => c.ticketId);
      contained = new Set(r.carried.filter((c) => c.contained).map((c) => c.ticketId));
    } else {
      // An older runner: the host's pull requests are the only other answer, and they must give one.
      ids = await carriedOnHost(t, gitHost, gitApiBase, others);
    }
    return others.filter((o) => ids.includes(o.ticketId)).map((o) => ({ ticketId: o.ticketId, branch: o.branch, title: o.title, risk: o.risk, contained: contained.has(o.ticketId) }));
  }

  /**
   * Whether a carried ticket is already fully approved and only waiting to merge (BOS-372): in review, every
   * review passed, and no owner sign-off open. Its work is then reviewed, so a branch holding all of it may
   * land it too. Anything less (still in review rounds, sent back, awaiting the owner) stays a refusal.
   */
  async function approvedAndWaiting(ticketId: string): Promise<boolean> {
    const [c] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!c || c.systemState !== "review") return false;
    // Owed the owner's sign-off, card or not: not approved yet (BOS-503, DR-021). A missing card never means "not needed".
    const so = (await derivedSignoff(db, c)).state;
    if (so !== "not_needed" && so !== "signed_off") return false;
    const rows = await latestRows(db, ticketId);
    if (!rows.length || evaluate(rows) !== "passed") return false;
    // The one "held at the merge gate" answer (DR-061 Q2b): the sign-off card, a hold, a card marked as holding the
    // merge (BOS-1078) and waits on tickets not yet in force (BOS-1173).
    return (await mergeHolds(db, ticketId)).length === 0;
  }

  /**
   * The host's own answer, for a runner too old to compare branches (BOS-130): a ticket is carried
   * when the commit its pull request was reviewed at is one of the commits this ticket's pull
   * request is made of, up to the commit that was reviewed. An open pull request carries that too,
   * since its head is the reviewed commit and this branch already has it. Anything the host can't
   * answer is an error, never an empty list, so nothing merges on a guess.
   */
  async function carriedOnHost(t: typeof tickets.$inferSelect, gitHost: string | null, gitApiBase: string | null, others: Array<{ ticketId: string; branch: string; title: string }>): Promise<string[]> {
    if (!deps.gitHosts || !deps.gitToken || (gitHost !== "github" && gitHost !== "gitea") || !gitApiBase)
      throw new ReviewError(409, "Couldn't check whether this branch carries other tickets' unmerged work: Boss Man doesn't know this project's git host or has no git token. Nothing was merged.");
    const { t: fresh, defaultBranch, repoUrl } = await ticketWithRepo(t.id);
    const { cfg, token } = await prTarget(fresh.companyId, repoUrl, gitHost, gitApiBase);
    const viaHost = deps.gitHosts;
    // The commit the host reviewed each other open ticket's pull request at.
    const theirs: Array<{ ticketId: string; head: string }> = [];
    for (const o of others) {
      const [row] = await db.select({ number: tickets.pullRequestNumber, head: tickets.pullRequestHead, branch: tickets.branch }).from(tickets).where(eq(tickets.id, o.ticketId));
      if (!row?.branch) continue;
      // No pull request yet: the branch's own head at the host is what is waiting to land.
      const head = row.head ?? (await viaHost.branchHead(cfg, token, row.branch).catch((err) => {
        // A branch the host has never seen carries nothing onto the target, so it can't be
        // carried by this one either (BOS-577). Any other failure still refuses: the gate can't
        // answer for a branch that does exist.
        if (err instanceof GitHostError && err.status === 404) return null;
        throw new ReviewError(409, `Couldn't read the branch of "${o.title}" on the host, so it wasn't merged: ${(err as Error).message}`);
      }));
      if (head) theirs.push({ ticketId: o.ticketId, head });
    }
    if (!theirs.length) return [];
    let mine: string[];
    try {
      if (fresh.pullRequestNumber) mine = (await viaHost.getWithCommits(cfg, token, fresh.pullRequestNumber, fresh.pullRequestHead)).commits;
      // No pull request yet: the commits on the branch since the target, from the host's compare.
      else mine = fresh.branch ? await viaHost.compare(cfg, token, defaultBranch, fresh.branch) : [];
    } catch (err) {
      throw new ReviewError(409, `Couldn't read this branch's commits on the host, so it wasn't merged: ${(err as Error).message}`);
    }
    return theirs.filter((x) => mine.includes(x.head)).map((x) => x.ticketId);
  }

  /**
   * What to do when the check can't say whether the branch carries other open tickets' work
   * (BOS-130): a safety gate refuses when it can't answer. Nothing merges, the ticket stays in
   * review with the reason on it, the owner hears, and the assignee is asked to move it back.
   */
  async function refuseUnchecked(t: typeof tickets.$inferSelect, err: ReviewError) {
    await wait(t, `Not merged: Boss Man couldn't check whether this branch carries other tickets' unmerged work (${err.message}). Nothing was merged.`, "unchecked");
    const text = `The review of "${t.title}" was approved, but Boss Man couldn't check whether its branch carries other tickets' unmerged work (${err.message}), so it didn't merge. Move the ticket back to review to try again.`;
    const delivered = await tellAgent({ ...t, systemState: "in_progress" }, text, "carried check failed").catch(() => null);
    return { outcome: "carried" as const, delivered, detail: { unchecked: err.message } };
  }

  /**
   * What to do when the branch carries other open tickets' work (BOS-130): nothing merges. When one
   * of them would need the owner's sign-off at its risk, they're told, so its review, deeper check
   * and staging aren't skipped by riding on this ticket. There is never a merge to approve here:
   * the carried ticket has to merge first.
   */
  async function refuseCarried(t: typeof tickets.$inferSelect, carried: CarriedInfo[], o: { reviewerAgentId: string | null }) {
    const names = carried.map((c) => `"${c.title}"`).join(", ");
    const theirRisk = riskOf(highestRisk(carried.map((c) => c.risk)));
    const detail = { carried: carried.map((c) => ({ ticketId: c.ticketId, title: c.title, risk: c.risk })) };
    // The ticket stays in review, with the reason on it, until the carried ticket has merged. The sentence
    // is what the owner reads; the carried tickets' titles sit on their own last line as JSON, so a title
    // holding a quote or an apostrophe is never cut out of the prose (BOS-819).
    const note = `${CARRIED_NOTE_PREFIX} unapproved work from ${names} (${theirRisk} risk), which must merge first.\n${JSON.stringify(carried.map((c) => c.title))}`;
    await db.update(tickets).set({ pullRequestNote: note }).where(eq(tickets.id, t.id));
    await lineEvent(db, t, { event: "hold_started", hold: "carried", carried: carried.map((c) => ({ ticketId: c.ticketId, title: c.title })) });
    const policy = await effectivePolicy(db, t);
    if (carried.some((c) => ruleFor(policy, c.risk).ownerSignoff)) {
      const [d] = await db
        .insert(decisions)
        .values({
          companyId: t.companyId,
          kind: "question",
          question: `${names} (${theirRisk} risk) must be reviewed and merged before "${t.title}" can land: its branch carries that unmerged work. Merge ${names} first, then approve this ticket again.`,
          options: ["Got it"],
          recommendedOption: "Got it",
          raisedByAgentId: o.reviewerAgentId,
          tier: "owner",
          dedupeKey: `carried:${t.id}:${carried.map((c) => c.ticketId).sort().join(",")}`,
          context: { type: "carried", ticketId: t.id, carried: carried.map((c) => c.ticketId), risk: theirRisk },
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id });
      if (d) await addTicketDependency(db, { companyId: t.companyId, blockedTicketId: t.id, blockerDecisionId: d.id, actor: { type: "system" } });
    }
    const text = `The review of "${t.title}" was approved, but its branch also carries unmerged work from ${names}. Nothing was merged: ${names} must merge first. Once ${carried.length > 1 ? "those tickets have" : "it has"}, Boss Man starts this merge again by itself (BOS-733); the ticket stays in review, so don't move it.`;
    const delivered = await tellAgent(t, text, "carried work").catch(() => null);
    return { outcome: "carried" as const, delivered, detail };
  }

  /**
   * The work landed: done, unless a criterion can only be checked now that it is live (DR-024 #5). Then
   * the ticket goes back to its assignee to show those before it can close.
   */
  async function announceMerged(ticketId: string) {
    // The merge has landed; a failure to free a waiting ticket must not undo it. The release sweep catches it later.
    await deps.onMerged?.(ticketId).catch(() => undefined);
  }

  /** `at`: when the merge landed, for one recorded late (BOS-1645); mergedAt places it in merge order, so it must not be "now". */
  async function finishMerged(t: typeof tickets.$inferSelect, commit: string | null, files?: string[], at?: Date) {
    // A criterion still at fail when the work lands was put off, not failed (BOS-575): it stays on this
    // ticket, with its assignee, as an after-merge check, instead of the ticket closing on it.
    const carry = carryFailedOver(readCriteria(t.acceptanceCriteria), t.stateNote);
    await db
      .update(tickets)
      // mergedAt and touchesRunner (BOS-1021) place the merge and say whether the runners need a rebuild for it.
      .set({ mergeCommit: commit, pullRequestNote: null, ...(commit ? { mergedAt: at ?? new Date() } : {}), ...(commit ? { touchesRunner: files ? touchesRunnerCode(files) : true, touchesRunnerUpdate: files ? touchesRunnerUpdate(files) : null, deploysNothing: files ? deploysNothing(files) : null } : {}), ...(carry ? { acceptanceCriteria: carry.criteria, stateNote: carry.note, stateNoteAt: new Date() } : {}) })
      .where(eq(tickets.id, t.id));
    await announceMerged(t.id);
    if (carry) t = { ...t, acceptanceCriteria: carry.criteria, stateNote: carry.note };
    await lineEvent(db, t, { event: "merged", commit });
    if (commit) await tellCeoLiveFix(t, commit).catch(() => undefined);
    if (commit) await pagePriorityMerge(t).catch(() => undefined);
    const left = afterMergeLeft(t);
    // With a live check still to show, the ticket isn't finished: go straight to the assignee without a
    // brief done state in between, so done hooks (worktree release, notifications) never fire for it.
    if (!left) await deps.work.updateTicket(t.id, { state: "done", outcome: "completed", overLimit: true });
    return { outcome: "merged" as const, delivered: null, detail: { commit, ...(left ? { afterMerge: left } : {}), ...(carry ? { carried: carry.carried } : {}) } };
  }

  /** Checks the merged ticket now has to show: its after-merge criteria still without a pass or fail. */
  function afterMergeLeft(t: typeof tickets.$inferSelect): string[] | null {
    const left = unreportedAfterMerge(t.acceptanceCriteria, t.stateNote);
    return left.length ? left : null;
  }

  /**
   * Ends one ticket's go-live wait (BOS-1021) and wakes its assignee with the after-merge checks. `marked` is the
   * CEO's evidence when the company marked it live itself (BOS-1345), null when Boss Man saw the server run it.
   * True when the assignee was told.
   */
  async function releaseGoLive(t: typeof tickets.$inferSelect, marked: string | null): Promise<boolean> {
    // Claim it first: a second pass (the server update and a runner hello can land together) must not wake twice.
    const [claimed] = await db.update(tickets).set({ goLiveWait: null, goLiveWaitSince: null, liveAt: new Date() }).where(and(eq(tickets.id, t.id), isNotNull(tickets.goLiveWait))).returning({ id: tickets.id });
    if (!claimed) return false;
    const left = unreportedAfterMerge(t.acceptanceCriteria, t.stateNote);
    const quoted = left.map((c) => `"${c}"`).join(", ");
    if (!left.length || t.systemState === "done") return false;
    // A marked ticket says nothing about our runners: its company's code never runs on them.
    const runners = !marked && t.touchesRunner;
    await record(db, { companyId: t.companyId, ticketId: t.id, kind: "go_live", summary: marked ? `The CEO marked the merge live (${marked}): the after-merge checks can be made now.` : `The merge is live${runners ? " and the runners have it" : ""}: the after-merge checks can be made now.` });
    const text = `${t.mergeCommit ? `Merged as ${t.mergeCommit.slice(0, 12)}, and it is live now` : "It is live now"}${marked ? ` (the CEO marked it live: ${marked})` : runners ? ", with the runners rebuilt" : ""}. These checks can only be made now: ${quoted}. Report pass or fail for each and move the ticket to done. If only the owner can check one, put a card in front of them (raise_decision with blocksTicketId): answering it records their answer as that check's pass or fail, so you can close the ticket once they have. If a check fails on the live work, report it as fail and move the ticket to done: Boss Man opens the follow-up ticket for it, assigned to you, so don't make one by hand.`;
    // BOS-1171: the checks are work now, so the ticket leaves Blocked (resuming never counts as a new start).
    if (t.systemState === "blocked") await deps.work.updateTicket(t.id, { state: "in_progress", overLimit: true, internal: true }).catch(() => undefined);
    return !!(await tellAgent({ ...t, systemState: "in_progress" }, text, "after merge").catch(() => null));
  }

  /** After a real merge: close the ticket, or send it back to show the checks only a live host can settle. */
  async function closeAfterMerge(t: typeof tickets.$inferSelect, commit: string | null, causedByRunId?: string | null, files?: string[], at?: Date) {
    const r = await finishMerged(t, commit, files, at);
    if (!r.detail.afterMerge) return { outcome: "merged" as const, delivered: null, detail: r.detail };
    const merged = commit ? `Merged as ${commit.slice(0, 12)}. ` : "Merged. ";
    // The branch is merged, so its working copy would be released (and checking on it would need a fresh
    // clone): it's kept for this pass so the agent can show the live result where it was.
    const [repoUrl] = await db
      .select({ repoUrl: projects.repoUrl })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, t.id));
    // BOS-1021: the merge is not running yet (server not updated, or runner code the runners lack): the checks
    // can't pass, so nobody is woken and no owner card is asked for. Boss Man wakes the assignee at go-live.
    const waitsFor = commit ? await goLiveWaitOf(db, { companyId: t.companyId, mergeCommit: commit, touchesRunner: files ? touchesRunnerCode(files) : true, liveMarkedAt: null }) : null;
    // BOS-1171: while the checks only wait for go-live the ticket sits in Blocked, so it holds no in-progress slot;
    // releaseGoLiveWaiters moves it to in progress when it wakes the assignee.
    if (repoUrl?.repoUrl) await deps.work.updateTicket(t.id, { state: waitsFor ? "blocked" : "in_progress", overLimit: true, internal: true, noCode: true });
    const carried = r.detail.carried ?? [];
    const quoted = (list: string[]) => list.map((c) => `"${c}"`).join(", ");
    if (waitsFor) {
      // A mark from an earlier merge of this ticket (BOS-1345) doesn't cover this one: this merge is judged as new.
      await db.update(tickets).set({ goLiveWait: waitsFor, goLiveWaitSince: new Date(), liveMarkedAt: null, liveEvidence: null }).where(eq(tickets.id, t.id));
      await record(db, { companyId: t.companyId, ticketId: t.id, kind: "go_live_wait", summary: `Merged as ${commit!.slice(0, 12)}; ${goLiveWaitWords(waitsFor)}. The after-merge checks (${quoted(r.detail.afterMerge!)}) start when it is live; the assignee is woken then.` });
      if (carried.length) await tellCeo(t, "after merge carried", `"${t.title}" merged with ${quoted(carried)} still at fail. It stays open as after-merge ${carried.length > 1 ? "checks" : "check"} and starts when the change is live (${goLiveWaitWords(waitsFor)}). Nothing to do unless it stalls.`).catch(() => undefined);
      return { outcome: "merged" as const, delivered: null, detail: { ...r.detail, commit, goLiveWait: waitsFor } };
    }
    const carriedWhy = carried.length ? ` ${quoted(carried)} ${carried.length > 1 ? "were" : "was"} still at fail when it merged, so ${carried.length > 1 ? "they stay" : "it stays"} on this ticket as after-merge ${carried.length > 1 ? "checks" : "check"}, not a separate ticket.` : "";
    const delivered = await tellAgent(
      { ...t, systemState: "in_progress" },
      `${merged}The work is live, so these checks can only be made now: ${quoted(r.detail.afterMerge!)}.${carriedWhy} Report pass or fail for each and move the ticket to done. If only the owner can check one, put a card in front of them (raise_decision with blocksTicketId): answering it records their answer as that check's pass or fail, so you can close the ticket once they have. If a check fails on the live work, report it as fail and move the ticket to done: Boss Man opens the follow-up ticket for it, assigned to you, so don't make one by hand.`,
      "after merge",
      causedByRunId,
    ).catch(() => null);
    // The CEO hears when a merge leaves a put-off check on its ticket (BOS-575): that is the moment BOS-542 was lost.
    if (carried.length) await tellCeo(t, "after merge carried", `"${t.title}" merged with ${quoted(carried)} still at fail. Boss Man kept it open with its assignee as after-merge ${carried.length > 1 ? "checks" : "check"} until ${carried.length > 1 ? "they are" : "it is"} reported; no follow-up ticket is needed. Nothing to do unless it stalls.`).catch(() => undefined);
    return { outcome: "merged" as const, delivered, detail: { ...r.detail, commit } };
  }

  /**
   * A merged ticket that fixes a live problem (BOS-639) wakes the CEO with the same words the deploy card will
   * lead with, so the chat says it too. Only a hand-set "fixes live" marker counts, never priority. Nothing is
   * deployed: the owner still approves the deploy card, which the host deployer raises once it sees the merge.
   */
  async function tellCeoLiveFix(t: { id: string; companyId: string; number: number | null; fixesLive: string | null }, commit: string) {
    const symptom = t.fixesLive?.trim();
    if (!symptom) return;
    const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
    const ref = ticketRef(c?.prefix ?? null, t.number) ?? "this ticket";
    const heading = fixesLiveHeading([{ symptom, ref }]);
    await tellCeo(
      t,
      "fixes live merged",
      `${heading}. It merged as ${commit.slice(0, 12)}. The live server still runs the old code until the owner approves the deploy card, which Boss Man raises headed with these words and sorted first in Decisions. Make sure the owner knows; Boss Man never deploys by itself.`,
    );
  }

  /**
   * BOS-1516: the owner's Priority 1 work merged. A company with a card that puts work live pages through that card (Boss Man's
   * own update card: "Ready to put live", see self-deploy urgentFor; a deploy target: the deploy card, see deploys.ts). A company
   * with neither has no card, so it is paged here, once, when the last ticket of the group merges: "Priority 1 work merged" and
   * the next step if the ticket names one.
   */
  async function pagePriorityMerge(t: { id: string; companyId: string; title: string; number: number | null; urgent: boolean; ownerSetup: string | null }) {
    const [mark] = await db.select({ byOwner: tickets.urgentByOwner }).from(tickets).where(eq(tickets.id, t.id));
    if (!t.urgent || !mark?.byOwner) return;
    const [target] = await db.select({ id: deployTargets.id }).from(deployTargets).where(eq(deployTargets.companyId, t.companyId)).limit(1);
    if (target) return;
    const [card] = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.companyId, t.companyId), sql`${decisions.context}->>'type' = 'self_deploy'`)).limit(1);
    if (card) return;
    if (!(await priorityGroup(db, t.id)).every((m) => m.finished)) return;
    const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
    const ref = ticketRef(c?.prefix ?? null, t.number);
    const next = t.ownerSetup?.trim().split("\n")[0]?.slice(0, 200);
    await deps.notes?.notify({
      companyId: t.companyId,
      agentId: null,
      level: "page",
      urgentReason: "Work you marked Priority 1 has merged",
      title: `Priority 1 work merged: ${t.title}${ref ? ` (${ref})` : ""}`,
      body: next ? `Next step: ${next}` : "Nothing more is needed from you for it to be in place.",
      link: `#/tickets/${t.id}`,
    });
  }

  /** Wakes the company's CEO about a ticket, with a note; nothing when the company has no CEO. */
  async function tellCeo(t: { id: string; companyId: string }, reason: string, note: string) {
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
    if (ceo) await wake?.(ceo.id, { ticketId: t.id, reason, note });
    return ceo?.id ?? null;
  }

  /** The ticket stays in review with the host's reason; the owner hears once per new reason. */
  async function wait(t: typeof tickets.$inferSelect, note: string, hold: HoldReason = "host") {
    const changed = note !== t.pullRequestNote;
    await db.update(tickets).set({ pullRequestNote: note }).where(eq(tickets.id, t.id));
    await lineEvent(db, t, { event: "hold_started", hold, note: note.slice(0, 200) });
    if (changed)
      await deps.notes?.notify({
        companyId: t.companyId,
        agentId: null,
        level: "note",
        title: `Pull request waiting: ${t.title}`,
        body: `${note}${t.pullRequestUrl ? `\n${t.pullRequestUrl}` : ""}`,
        link: `#/tickets/${t.id}`,
      });
    return { outcome: "pull_request" as const, delivered: null, detail: { note, url: t.pullRequestUrl } };
  }

  /** Tells the ticket's assignee: into its live run if it has one, otherwise by waking it (notify decides). */
  async function tellAgent(ticket: typeof tickets.$inferSelect, text: string, reason: string, causedByRunId?: string | null) {
    if (!ticket.assigneeAgentId || !wake) throw new ReviewError(409, "The ticket has no assignee to send this to.");
    const w = (await wake(ticket.assigneeAgentId, { ticketId: ticket.id, reason, priority: 3, note: text, causedByRunId })) as { status: string };
    return w.status === "steered" ? "sent to the running agent" : "the assignee will be woken with it";
  }

  /** BOS-313: whether the merge gate checks the merged result it pushes. Off until the owner turns it on; off keeps the old path. */
  async function checkMergedResult(): Promise<boolean> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, CHECK_MERGED_KEY));
    return row?.value === true;
  }

  /** BOS-1070: whether the merge gate waits for the git host's CI on the merge commit. Off until the owner turns it on; off keeps today's path. */
  async function waitForCi(): Promise<boolean> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, WAIT_FOR_CI_KEY));
    return row?.value === true;
  }

  async function templates(companyId: string): Promise<GitTemplates> {
    const [row] = await db.select().from(settings).where(eq(settings.key, `git_templates:${companyId}`));
    return { ...DEFAULT_GIT_TEMPLATES, ...((row?.value as Partial<GitTemplates> | undefined) ?? {}) };
  }

  /** Checks a "Passed, hold merge" before anything is recorded (BOS-808): a reason, something it waits for, and nothing already held. */
  async function checkHoldInput(t: typeof tickets.$inferSelect, hold: HoldInput, reviewerAgentId: string | null | undefined) {
    if (!reviewerAgentId) throw new ReviewError(422, "Only a reviewer holds a merge; the owner can simply not approve it yet.");
    if (t.systemState !== "review") throw new ReviewError(409, "A merge can only be held while the ticket is in review.");
    if (!hold.reason.trim()) throw new ReviewError(422, "Say why the merge is held (holdReason).");
    if (!hold.waitsOn.length && !hold.releaseAt) throw new ReviewError(422, "A hold needs something to end it: the tickets or decisions it waits on (waitsOn), a date (holdUntil), or both.");
    if (hold.releaseAt && hold.releaseAt.getTime() <= Date.now()) throw new ReviewError(422, "The hold date is already past (holdUntil).");
    if (await openHold(db, t.id)) throw new ReviewError(409, "This ticket already has a hold. Release or cancel it first.");
    for (const w of hold.waitsOn) {
      if ("ticketId" in w) {
        const [o] = await db.select({ companyId: tickets.companyId, state: tickets.systemState }).from(tickets).where(eq(tickets.id, w.ticketId));
        if (!o || o.companyId !== t.companyId) throw new ReviewError(422, "A ticket the hold waits on was not found in this company.");
        if (w.ticketId === t.id) throw new ReviewError(422, "A ticket can't wait on itself.");
        if (o.state === "done") throw new ReviewError(422, "A ticket the hold waits on is already closed.");
      } else {
        const [o] = await db.select({ companyId: decisions.companyId, status: decisions.status }).from(decisions).where(eq(decisions.id, w.decisionId));
        if (!o || o.companyId !== t.companyId) throw new ReviewError(422, "A decision the hold waits on was not found in this company.");
        if (o.status !== "open") throw new ReviewError(422, "A decision the hold waits on is already answered.");
      }
    }
  }

  /** Records the hold and the activity line for it (BOS-808). */
  async function startHold(t: typeof tickets.$inferSelect, row: ReviewRow, hold: HoldInput, reviewer: string) {
    const h = await createHold(db, { ticketId: t.id, reviewRequestId: row.id, reviewerAgentId: row.reviewerAgentId, reason: hold.reason.trim(), releaseAt: hold.releaseAt, waits: hold.waitsOn });
    await record(db, { companyId: t.companyId, agentId: row.reviewerAgentId, ticketId: t.id, kind: "review_hold_started", summary: `${reviewer} passed the review but is holding the merge: ${hold.reason.trim()}` });
    return h;
  }

  /** "BOS-1095, BOS-1100" for these tickets, by reference (title when a ticket has no number). */
  async function refsOf(ticketIds: string[]): Promise<string> {
    if (!ticketIds.length) return "";
    const rows = await db.select({ id: tickets.id, number: tickets.number, title: tickets.title, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(inArray(tickets.id, ticketIds));
    return rows.map((r) => ticketRef(r.prefix, r.number) ?? `"${r.title}"`).join(", ");
  }

  /**
   * The wait before any check runs (BOS-1173, DR-053): an approved ticket whose merge waits on another ticket (its
   * own waits-on link, or an open ticket marked as fixing the merge check) goes into "Passed, held" on it. Nothing
   * is checked, nothing goes back to the author, no loop failure is counted and no card is raised; the hold is
   * released by itself once that ticket is merged and live. Null when nothing holds it.
   */
  async function holdForWaits(ticketId: string): Promise<ReviewHeldError | null> {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!t) return null;
    const waits = await mergeWaits(db, t);
    if (!waits.length) return null;
    const refs = await refsOf(waits);
    const { added } = await ensureSystemHold(db, t.id, waits, `Waits on ${refs}: it merges by itself once ${waits.length > 1 ? "they are" : "that is"} merged and live.`);
    if (added) {
      await lineEvent(db, t, { event: "hold_started", hold: "waits_on", note: `waits on ${refs}`.slice(0, 200) });
      await record(db, { companyId: t.companyId, ticketId: t.id, kind: "review_hold_started", summary: `Approved and held: the merge waits on ${refs}, so the check didn't run and nothing was sent back. It merges by itself once ${refs} is merged and live; the reviews and any sign-off stand. Nothing to do.` });
    }
    return new ReviewHeldError(`This ticket's merge waits on ${refs}, so nothing was checked or merged. It stays approved in "Passed, held" and merges by itself once ${refs} is merged and live; leave it in review.`);
  }

  /** True while the owner's "Merge it, or send it back?" sign-off card for this ticket is open (BOS-471). */
  async function ownerSignoffOpen(ticketId: string): Promise<boolean> {
    return !!(await openSignoffCard(db, ticketId));
  }

  /**
   * Throws the refusal for whatever holds this ticket's merge (DR-061 Q2b, mergeHolds): the owner's sign-off card,
   * then a hold, then a holding card, then a wait on another ticket (which also puts it in "Passed, held").
   */
  async function refuseIfHeld(ticketId: string): Promise<void> {
    const [first] = await mergeHolds(db, ticketId);
    if (!first) return;
    if (first.kind === "signoff") throw new SignoffPendingError();
    if (first.kind === "hold") throw new ReviewHeldError();
    if (first.kind === "card") throw cardHeld(first.id);
    const waiting = await holdForWaits(ticketId);
    if (waiting) throw waiting;
  }

  return {
    setWakeHook(hook: NotifyHook) {
      wake = hook;
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
          if (ceo) await wake?.(ceo.id, { reason: "decision", note: `A decision is waiting for you: ${question}\nUse the decisions tool to read it and answer.` });
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
        await decide(db, row.id, { status: "changes_requested", notes: formatReviewComments(who, input.comments ?? [], diffText, input.summary), comments: input.comments ?? [] });
      }
      return this.settle(t, { verdict: input.verdict, reviewer: input.reviewer, reviewerAgentId: input.reviewerAgentId!, background: input.background, causedByRunId: input.causedByRunId, before: active });
    },

    /** After a verdict, an overrule or a new order: wake who is next, send the work back, or approve it. */
    async settle(t: typeof tickets.$inferSelect, o: { verdict: "approved" | "changes_requested"; reviewer: string; reviewerAgentId: string; background?: boolean; causedByRunId?: string | null; before: ReviewRow[] }) {
      const rows = await latestRows(db, t.id);
      const state = evaluate(rows);
      if (state === "waiting") {
        const was = new Set(o.before.map((r) => r.id));
        if (wake) await wakeReviewers(db, t, activeRows(rows).filter((r) => !was.has(r.id)), (id, i) => wake!(id, i), [], o.causedByRunId);
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
            if (wake) await wakeReviewers(db, t, activeRows(reopened).filter((r) => stale.some((s) => s.id === r.id)), (id, i) => wake!(id, i), [], o.causedByRunId);
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

    /** The CEO sets the order of a ticket's reviews, for when one depends on another. */
    async sequence(ticketId: string, order: string[], byAgentId: string, companyId: string) {
      const { t } = await ticketWithRepo(ticketId, companyId);
      const woken = await setReviewOrder(db, t, order, byAgentId);
      if (wake) await wakeReviewers(db, t, woken, (id, i) => wake!(id, i));
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

    /** Who may end a hold: the reviewer who set it, the CEO, or the owner (no agent). */
    async holdActorCheck(ticketId: string, by: HoldActor) {
      const hold = await openHold(db, ticketId);
      if (!hold) throw new ReviewError(409, "That ticket has no hold.");
      if (by.agentId && !by.isCeo && hold.reviewerAgentId !== by.agentId) throw new ReviewError(403, "Only the reviewer who set the hold, the CEO or the owner can release or cancel it.");
      return hold;
    },

    /**
     * Release (BOS-808): the hold ends, the reviewer's pass stands, and the normal approve path runs next, so owner sign-off
     * and the merge gate apply exactly as for any approval.
     */
    async releaseHold(ticketId: string, by: HoldActor, o: { companyId?: string; background?: boolean; causedByRunId?: string | null } = {}) {
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
    },

    /** Cancel (BOS-808): the pass is withdrawn (the slot goes back to pending), so the work is reviewed again. */
    async cancelHold(ticketId: string, by: HoldActor, o: { companyId?: string } = {}) {
      const { t } = await ticketWithRepo(ticketId, o.companyId);
      const hold = await this.holdActorCheck(ticketId, by);
      if (!(await closeHold(db, hold, "cancelled", by.name))) throw new ReviewError(409, "That hold was already ended.");
      await record(db, { companyId: t.companyId, agentId: by.agentId ?? null, ticketId, kind: "review_hold_cancelled", summary: `${by.name} cancelled the hold; the earlier pass no longer counts, so the work is reviewed again.` });
      const rows = await latestRows(db, ticketId);
      if (wake && t.systemState === "review") await wakeReviewers(db, t, activeRows(rows).filter((r) => r.id === hold.reviewRequestId), (id, i) => wake!(id, i));
      return { outcome: "cancelled" as const, delivered: "cancelled; the review is open again" };
    },

    /**
     * BOS-1021: for every merged ticket of the company whose after-merge checks wait for go-live, looks again at
     * what is still missing. Once the server runs the merge (and the runners have it, for runner code) the wait is
     * cleared and the assignee is woken with the live checks; until then nothing is sent. Returns how many were woken.
     */
    async releaseGoLiveWaiters(companyId: string) {
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
    },

    /**
     * BOS-1345: the CEO of a company that puts its own work live says a merged ticket is live, with evidence (a commit
     * sha or a short note). The wait ends as at a server go-live: the assignee is woken with the after-merge checks.
     * Refused for the home company, whose go-live is the server update. The role check is the caller's (CEO only).
     */
    async markLive(ticketId: string, companyId: string, input: { evidence: string; by: string }) {
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
    },

    /**
     * The owner's (or CEO's) "move these checks to after the merge" on a stuck-review card (BOS-422): the named criteria become
     * after-merge ones, the changes-requested reviews that only failed them are overruled, and the ticket goes on through review.
     * Owner sign-off still applies, as it does after an overrule.
     */
    async moveAfterMerge(ticketId: string, criteria: string[]) {
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
    },

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
      const word = { queued: "queued for a check slot", checking: "checking", merging: "merging", waiting_to_retry: "waiting to try again after the runner restarted" }[l.phase ?? "checking"];
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
    runningMerges(): Array<{ ticketId: string; startedAt: string; startedBy: string; phase?: "queued" | "checking" | "merging" | "waiting_to_retry"; ci?: { since: string; waiting: string[] } }> {
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
      const ids = [...landings.entries()].filter(([id, l]) => l.state === "running" && phases.get(id) === "merging").map(([id]) => id);
      const out = new Map<string, number>();
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
      if (missedSweep) return missedSweep.then(() => ({ recorded }));
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
        for (const [companyId, onMain] of read) await wakeCeoIfLiveUnplaced(db, companyId, onMain, wake).catch(() => false);
      })();
      missedSweep = pass;
      try {
        await pass;
      } finally {
        missedSweep = null;
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
          await raiseMergeStuck(db, row, message);
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
        if (wake) await wakeReviewers(db, t, [{ ...r, reviewerAgentId: byAgentId }], (id, i) => wake!(id, i));
        return true;
      }
      if (answer === REASSIGN_REVIEW) {
        const rule = ruleFor(await effectivePolicy(db, t), t.risk);
        const ref = slotRef(rule, r.kind as ReviewSlot);
        const [to] = ref ? (await otherReviewers(db, t, r.kind as ReviewSlot, ref, [r.reviewerAgentId ?? ""])).filter((a) => a.id !== byAgentId) : [];
        if (!to) throw new ReviewError(409, "No other qualified reviewer is free to take it. Take it yourself, send it back to the author, or leave it another hour.");
        await db.update(reviewRequests).set({ reviewerAgentId: to.id }).where(eq(reviewRequests.id, r.id));
        await record(db, { companyId: t.companyId, agentId: byAgentId, ticketId: t.id, kind: "review_handover", summary: `${actor} gave the ${r.kind} review to ${to.name}, from ${who?.name ?? "the reviewer"}.` });
        if (wake) await wakeReviewers(db, t, [{ ...r, reviewerAgentId: to.id }], (id, i) => wake!(id, i));
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
        await recordFailedAttempt(db, { alert: deps.alert }, lineRow, reason, typeof jobId === "string" ? jobId : undefined, note);
      };
      try {
        // A merge check that only waited too long for the shared lock is queued again, with a longer pause each time.
        // The ticket stays in review; the pause counts as activity so the unmerged-approvals sweep leaves it alone.
        let goneTries = 0;
        for (let attempt = 1; ; attempt++) {
          let r: Awaited<ReturnType<typeof this.landOnce>> | { outcome: "runner_gone"; delivered: null; detail: { message: string } };
          try {
            r = await this.landOnce(ticketId, reviewer, causedByRunId, opts, begun);
          } catch (err) {
            if (!(err instanceof RunnerGone)) throw err;
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
              await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The runner kept going away under the merge (${message}); it's in your Decisions.` });
              await raiseCheckStuck(db, t, "the merge", "was cut off because the runner restarted or went away", message);
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
          const { t } = await ticketWithRepo(ticketId);
          // A main_moved lock wait carries only { status } (no command or output): BOS-1604 crashed here with "reading 'slice'".
          const d = r.detail as { command?: string; output?: string; status?: string } | undefined;
          if (attempt >= LOCK_RETRY_ATTEMPTS) {
            const moved = d?.status === "main_moved";
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: moved ? `The merge gave up after ${attempt} tries: main kept moving before it could land; it's in your Decisions.` : `Merge check gave up waiting for the lock after ${attempt} tries; it's in your Decisions.` });
            await raiseCheckStuck(db, t, d?.command ?? "the merge", moved ? "kept finding that main had moved before it could land" : "kept waiting for the shared lock, which other checks held", d?.output ?? "");
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
        await failed("gate_fault", undefined, err.message);
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_failed", summary: `Approved, but the merge couldn't run: ${err.message}` });
        await raiseMergeStuck(db, t, err.message);
        // Whoever approved still hears why, as before.
        throw err;
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

    async landOnce(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions, begun: Date = new Date()): Promise<{ outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted" | "carried" | "migration_journal" | "branch_changed"; delivered: string | null; detail?: unknown }> {
      const { t, repoUrl, defaultBranch, verifyCommand, deepVerifyCommand, landing, gitHost, gitApiBase } = await ticketWithRepo(ticketId);
      // An answer to an older "merge stuck" ask can arrive after the ticket merged: nothing to do again.
      if (t.systemState === "done") return { outcome: "done", delivered: null, detail: { note: "It was already finished, so nothing ran again." } };
      // A retry must not merge past the owner's sign-off (BOS-149): if a "Merge it, or send it back?"
      // card is still open, this ticket waits for the owner, whatever answered the merge card.
      // Nor past a reviewer's hold (BOS-808), an open card raised on the ticket (BOS-919) or a wait on another ticket
      // (BOS-1173); every merge path comes through here, so this fails them all closed and none runs a check it is
      // known to fail for a reason the branch didn't cause.
      await refuseIfHeld(ticketId);
      // Nor past a sign-off that isn't recorded (BOS-503, DR-021): a lost card used to let the unmerged-approvals
      // retry and carried-work landing merge a high-risk ticket the owner never saw. Every path into a merge comes
      // through here, so this one check fails them all closed. A card that went missing is raised again.
      await this.requireSignoff(t, null);
      // A merge under way is activity: the unmerged-approvals sweep waits for it rather than asking again.
      const touch = () => beatNow(ticketId);
      await touch();
      // BOS-1769: out of review now, or out and back since this landing began (`begun`, from land()). Either way this pass
      // through the line is over: a retry or the back-in-review restart starts the next one, so this landing must stop
      // rather than keep polling (and beating the heartbeat that keeps its marker alive) for hours.
      const inReview = async () => {
        const [now] = await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, ticketId));
        return now?.state === "review";
      };
      const leftReview = async () => !(await inReview()) || (await leftLineSince(db, ticketId, begun));
      if (!repoUrl) {
        await lineEvent(db, t, { event: "merged", commit: null });
        await deps.work.updateTicket(ticketId, { state: "done", outcome: "completed", overLimit: true });
        return { outcome: "done", delivered: null };
      }
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      if (!runner) throw new ReviewError(409, "The company has no runner.");
      const ask = async <T>(build: (requestId: string) => Parameters<typeof deps.runners.send>[1], timeoutMs: number) => {
        try {
          // A runner that is away (a swap takes minutes) is waited for, not retried against: no try is used until a request is delivered.
          // The wait sits inside the check gate's slot, so queued merges keep their order and never run out of the line.
          if (!deps.runners.isConnected(runner.id)) {
            const beat = setInterval(() => void touch().catch(() => undefined), MERGE_ACTIVITY_MS);
            beat.unref?.();
            try {
              if (!(await deps.runners.waitConnected(runner.id, RUNNER_WAIT_MS))) throw new RunnerGone("The company's runner stayed offline.");
            } finally {
              clearInterval(beat);
            }
          }
          return await deps.runners.request<T>(runner.id, build, timeoutMs);
        } catch (err) {
          // The runner went away: land() runs the merge again by itself instead of raising a card (DR-014).
          if (err instanceof RunnerGone) throw err;
          // The repo lock stayed taken (a restart leaves many runs queued for it): nothing is wrong, so land() asks again
          // by itself and only raises a card when the retries fail too (BOS-1396).
          if (/^Timed out waiting for the lock on /.test((err as Error).message)) throw new RunnerGone((err as Error).message);
          throw new ReviewError(409, (err as Error).message);
        }
      };
      const sendBack = async (text: string, reason: string) => {
        await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
        return tellAgent({ ...t, systemState: "in_progress" }, text, reason, causedByRunId);
      };
      // BOS-1723: the bounce's record in the ticket's conversation, kept after the wake note is gone. Never stops the bounce.
      const keepBounce = async (text: string) => {
        try {
          await db.insert(ticketMessages).values({ companyId: t.companyId, ticketId, author: "system", text });
        } catch (err) {
          console.warn(`bounce record for ticket ${ticketId} not kept: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      // Checks can run for half an hour and merges can queue behind other work: keep saying the ticket
      // is active while we wait, so the unmerged-approvals sweep never starts a second landing beside it.
      const whileActive = async <T>(work: () => Promise<T>): Promise<T> => {
        // Only while the runner is connected (DR-014): a merge waiting on a runner that has gone must not look alive.
        const beat = setInterval(() => { if (deps.runners.isConnected(runner.id)) void touch().catch(() => undefined); }, MERGE_ACTIVITY_MS);
        beat.unref?.();
        try {
          return await work();
        } finally {
          clearInterval(beat);
        }
      };

      // Nothing changed in the repository (a wiki-only ticket, say): there is nothing to check or
      // merge, and running the check anyway could send the ticket back for a failure it can't fix.
      // A runner that went away is not "no diff": land() asks again once it is back (BOS-1396). Other failures read as no diff.
      const readDiff = () => whileActive(() => ask<WorkspaceDiff>((requestId) => ({ type: "workspace.diff", requestId, projectId: t.projectId, ticketId, baseRef: defaultBranch }), 60_000)).catch((err: unknown) => { if (err instanceof RunnerGone) throw err; return null; });
      let changed = await readDiff();
      // A ticket sent back after its merge as no-code, then reopened for real work (BOS-532): a commit on its
      // branch now is that work. Clear the stale no-code mark and read the diff again (a diff read over the
      // old commit may show nothing), so the review checks code and the branch merges like any other.
      let noCode = t.noCode;
      if (noCode && changed?.commits.length) {
        await db.update(tickets).set({ noCode: false }).where(eq(tickets.id, ticketId));
        await record(db, { companyId: t.companyId, ticketId, kind: "reopened", summary: "Reopened for code: its branch has new commits again, so it is no longer a no-code ticket." });
        noCode = false;
        changed = await readDiff();
      }
      // BOS-1647: a head already inside the default branch is a push that landed whose record was lost: record it, never push
      // or bounce it ("nothing changed") now that its diff is empty.
      const alreadyLanded = await this.recordLanded(ticketId, causedByRunId, changed);
      if (alreadyLanded) return alreadyLanded;
      // The owner signs off a commit (DR-013): the one about to merge must be it. No head read means no merge.
      // A ticket with no branch has nothing to merge, so only the early check above applies to it.
      // A diff that touches a file the owner approves (OWNER_APPROVED_PATHS: the merge gate and what it runs, and
      // CLAUDE.md) is held at high risk, so the owner's sign-off is needed even if nobody raised a card (BOS-1094,
      // BOS-1100). The sign-off machinery does the holding.
      // A diff that could not be read has an unknown file list, so it must not merge: it might change one of those
      // files. Fail closed the way a runner that went away does: land() asks again, and raises its card only when
      // the retries fail too (BOS-1396).
      if (!changed && t.branch) throw new RunnerGone("The runner couldn't say which files the ticket changes.");
      // Keep the files it changes, so the plan-overlap warning can read them without a runner call (BOS-1411). Never fails a merge.
      if (changed?.files.length) await db.update(tickets).set({ diffFiles: changed.files.map((f) => f.path).slice(0, 2000) }).where(eq(tickets.id, ticketId)).catch(() => undefined);
      const ownerFiles = ownerApprovedFiles(changed?.files.map((f) => f.path) ?? []);
      let because: string | undefined;
      if (ownerFiles.length) {
        because = `This ticket changes ${ownerFiles.join(", ")}, which the owner has to approve before it merges.`;
        if (RISK_TIERS.indexOf(riskOf(t.risk)) < RISK_TIERS.indexOf("high")) {
          await db.update(tickets).set({ risk: "high" }).where(eq(tickets.id, ticketId));
          t.risk = "high";
          await record(db, { companyId: t.companyId, ticketId, kind: "risk_raised", summary: `${because} Its risk was raised to high so it waits for the owner's sign-off.` });
        }
      }
      await this.requireSignoff(t, changed ? changed.head : t.branch ? "" : null, because);
      // BOS-1413: this head is the one the reviews and sign-off were checked against. Every merge step of this landing is pinned to
      // it, so a commit made while the check or a train seat waits is never built, checked or pushed. Only clean main merges
      // (signoffCovers) move the pin.
      // The pin is the head the approvals were given on (BOS-1173 stamps it), not the head read now: a landing that starts again
      // (lock wait, runner restart, resume, sweep) would otherwise pin whatever the author committed in the pause, and a
      // ticket that needs no sign-off has nothing else that compares it. A different head merges only when signoffCovers
      // says main was merged in cleanly (askMerge); otherwise it goes back for review. No stamped head (older rounds): the
      // head read now. A runner without "merge-pin" ignores the pin, so none is sent: it merges as before.
      const reviewedHead = changed?.head ? await this.passedHead(t, await latestRows(db, ticketId)).catch(() => null) : null;
      // BOS-1528: a round that has stamped approvals but no single passed head (mixed, or some unstamped) pins nothing reviewed:
      // fail closed instead of pinning the head read now. Rounds with no stamps at all (from before heads were kept) go on as before.
      if (changed?.head && !reviewedHead) {
        const approvedNow = (await latestRows(db, ticketId)).filter((r) => r.status === "approved");
        if (approvedNow.some((r) => r.head)) {
          const delivered = await sendBack(`The reviews were approved, but on different commits (or one has no commit recorded), so nothing was merged: the branch is at ${changed.head.slice(0, 8)}. Check the work, then move the ticket back to review for a fresh round.`, "approved heads differ");
          return { outcome: "branch_changed", delivered, detail: { status: "branch_moved", head: changed.head, pinned: "" } };
        }
      }
      const pinHead = reviewedHead ?? changed?.head;
      let pin: string | null = pinHead && /^[0-9a-f]{7,64}$/.test(pinHead) && deps.runners.can(runner.id, "merge-pin") ? pinHead : null;
      // Also used for the pull-request push (workspace.push), whose answer carries the same branch_moved status.
      const askMerge = async <R extends MergeResult | PushResult = MergeResult>(build: (requestId: string) => Record<string, unknown>, timeoutMs: number): Promise<R> => {
        for (let again = 0; ; again++) {
          const pinned = pin;
          const r = await ask<MergeResult | PushResult>((requestId) => ({ ...build(requestId), ...(pinned ? { pin: pinned } : {}) }) as never, timeoutMs);
          if (!pinned) return r as R;
          // A runner older than this change ignores the pin and doesn't name the branch commit: it can't be trusted to keep it.
          // A push answer naming another commit comes from a runner that announces merge-pin but drops the push pin: the branch
          // ref is out there, but no pull request may be opened or merged on it unless signoffCovers says it only added main.
          const head = r.status === "branch_moved" ? r.head : r.status === "prepared" && r.branchSha !== pinned ? (r.branchSha ?? "") : r.status === "pushed" && !(r.commit.startsWith(pinned) || pinned.startsWith(r.commit)) ? r.commit : null;
          if (head === null) return r as R;
          if (head && again < 3 && (await this.signoffCovers(ticketId, pinned, head))?.covers) {
            await record(db, { companyId: t.companyId, ticketId, kind: "signoff_carried", summary: `The approval of ${pinned.slice(0, 8)} still covers ${head.slice(0, 8)}: while the merge waited, main was only merged in automatically, with no clashes and no new code from the ticket.` });
            pin = head;
            continue;
          }
          return { status: "branch_moved", head, pinned } as R;
        }
      };
      if ((changed && !changed.commits.length && !changed.files.length) || (!changed && !t.branch)) {
        // Only a ticket marked "no code" closes on an empty diff; any other is sent back, not closed.
        if (!noCode) {
          const delivered = await sendBack(`The review was approved, but the ticket can't be closed: ${NOTHING_CHANGED} Then move the ticket back to review.`, "nothing changed");
          return { outcome: "empty", delivered };
        }
        // Nothing to merge, but a live check still can't be made before the change is live (DR-024 #5): keep it to show.
        if (afterMergeLeft(t)) return closeAfterMerge(t, null, causedByRunId);
        // The live check is reported, so this is the after-merge step: close the ticket. A merged ticket
        // reopened for real code (BOS-532) is already a code ticket: its mark was cleared when it was moved
        // back to ready or in_progress, or when a new commit landed (above), so it is sent back earlier.
        await lineEvent(db, t, { event: "merged", commit: null });
        await deps.work.updateTicket(ticketId, { state: "done", outcome: "completed", overLimit: true });
        return { outcome: "done", delivered: null, detail: { note: "Nothing in the repository changed, so there was nothing to check or merge." } };
      }

      // A branch that also carries another open ticket's unmerged work can't go on the target: that
      // work hasn't been reviewed, signed off or checked at its own risk (BOS-130). One approval is
      // never enough for two tickets, so this is checked before anything runs or is pushed.
      // A runner that is busy or silent is waited for: the check is asked again by itself, with a longer pause each
      // time (the ticket stays in review and keeps saying it is active), before the merge stops with a card.
      let carried: CarriedInfo[];
      for (let retry = 1; ; retry++) {
        try {
          carried = await whileActive(() => carriedBetween(runner.id, t, defaultBranch, gitHost, gitApiBase));
          break;
        } catch (err) {
          if (!(err instanceof ReviewError)) throw err;
          if (!err.retryable) {
            const r = await refuseUnchecked(t, err);
            return { outcome: r.outcome, delivered: r.delivered, detail: r.detail };
          }
          if (retry > INFRA_RETRY_ATTEMPTS) {
            // Retries used up: one "Run the check again" card, and the ticket stays in review so running it
            // again does not reset the reviews (BOS-460 stalled overnight on a reset request).
            await wait(t, `Not merged: the runner didn't answer the check for other tickets' unmerged work (${err.message}). Nothing was merged.`, "card");
            await raiseCheckStuck(db, t, "carried-work check", "the runner didn't answer the check for other tickets' unmerged work", err.message);
            return { outcome: "check_stuck", delivered: null, detail: { unchecked: err.message } };
          }
          const pause = INFRA_RETRY_BASE_MS * 2 ** (retry - 1);
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The runner didn't answer the check for other tickets' unmerged work; asking again (try ${retry} of ${INFRA_RETRY_ATTEMPTS}, in ${Math.max(1, Math.round(pause / 1000))}s). Nothing to do.` });
          await whileActive(() => new Promise((resolve) => setTimeout(resolve, pause)));
          const [now] = await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, ticketId));
          if (now?.state !== "review") return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while the check waited for the runner, so it was not retried." } };
        }
      }
      // Approved tickets whose whole branch this one holds (the fast-forward case, BOS-372) land together with it.
      const together: CarriedInfo[] = [];
      for (const c of carried) if (!opts?.skipChecks && c.contained && (await approvedAndWaiting(c.ticketId))) together.push(c);
      carried = carried.filter((c) => !together.includes(c));
      if (carried.length) {
        const r = await refuseCarried(t, carried, { reviewerAgentId: null });
        return { outcome: "carried", delivered: r.delivered ?? null, detail: r.detail };
      }

      // The project's check, plus its deeper one for high and critical work (R47, R48).
      // Deep check at the highest risk among this ticket and every ticket landing with it.
      const needsDeep = [t.risk, ...together.map((c) => c.risk)].some((r) => deepChecks(r));
      // BOS-665: when a different, deeper check runs next on the same tree, the project check is told so (FULL_CHECK_NEXT)
      // and may skip what the deeper one repeats (check-quick.sh drops its typecheck and related tests). It rides in the
      // command string because every way of running a check is `sh -c <command>`, so no runner change is needed; `named`
      // maps it back to the project's own command for messages and check results.
      const fullNext = needsDeep && !!deepVerifyCommand && !!verifyCommand && deepVerifyCommand !== verifyCommand;
      const project = verifyCommand && fullNext ? `export ${FULL_CHECK_NEXT}=1; ${verifyCommand}` : verifyCommand;
      // BOS-1365: the server queue runs both checks as ONE job (project check, then deep check), so no merge lands between them.
      const combinedCommand = fullNext ? `${project} && ${deepVerifyCommand}` : null;
      const combinedName = fullNext ? `${verifyCommand} && ${deepVerifyCommand}` : null;
      const named = (command: string) => (combinedCommand && command === combinedCommand ? combinedName! : command === project && verifyCommand ? verifyCommand : command);
      const checks = opts?.skipChecks ? [] : [project, needsDeep ? deepVerifyCommand : null].filter((c): c is string => !!c);
      const kindOf = (command: string) => (command === combinedCommand ? "deep_verify" : named(command) === deepVerifyCommand && named(command) !== verifyCommand ? "deep_verify" : "verify");
      // A merge check through a slot, timed for the merge-line record (BOS-769): queued, started when `slot` grants it,
      // ended with `verdict` (or null when it threw, as when the runner went away mid-check).
      const timedCheck = async <T>(check: string, way: CheckWay, slot: (w: () => Promise<T>) => Promise<T>, verdict: (r: T) => boolean | null, work: () => Promise<T>): Promise<T> => {
        await lineEvent(db, t, { event: "check_queued", check, way });
        try {
          const r = await slot(async () => {
            await lineEvent(db, t, { event: "check_started", check, way });
            return work();
          });
          await lineEvent(db, t, { event: "check_ended", check, way, passed: verdict(r) });
          return r;
        } catch (err) {
          await lineEvent(db, t, { event: "check_ended", check, way, passed: null, why: String((err as Error)?.message ?? err).slice(0, 200) });
          throw err;
        }
      };
      // A failed check: wait for the lock, a stuck check, or the ticket goes back with the output (shared by both ways of checking).
      const checkFailed = async (command: string, v: VerifyResult): Promise<{ outcome: "verify_failed" | "check_stuck" | "lock_wait"; delivered: string | null; detail: unknown }> => {
        // Only the wait for the shared lock ran out: no step ran, so nothing is wrong with the work. land() tries again.
        if (checkWaitedForLock(v)) return { outcome: "lock_wait", delivered: null, detail: { ...v, command } };
        if (checkQueueStuck(v)) {
          const mins = /no progress for (\d+) min/.exec(v.output)?.[1] ?? "60";
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The check queue made no progress for ${mins} minutes (the same check held the slot); the merge check gave up and it's in your Decisions.` });
          await raiseCheckStuck(db, t, command, `was stopped: the check queue made no progress for ${mins} minutes, because the check holding the slot never finished`, v.output);
          return { outcome: "check_stuck", delivered: null, detail: v };
        }
        const never: InfraCause | null = (v as { noAnswer?: boolean }).noAnswer ? "no_answer" : checkNeverFinished(v);
        if (never) {
          const reason = INFRA_CAUSE_TEXT[never](v.ms);
          await raiseCheckStuck(db, t, command, reason, v.output);
          return { outcome: "check_stuck", delivered: null, detail: v };
        }
        const why = v.timedOut ? "timed out" : `exited with code ${v.exitCode}`;
        // A fix to the merge check was marked, or a waits-on link added, while this check ran (BOS-1173): the failure
        // is the gate's until that fix is in force, so the ticket stays approved and held, not sent back or counted.
        const waiting = await holdForWaits(ticketId);
        if (waiting) throw waiting;
        // The same failing check again and again means the agent is going round in circles (R50).
        const loop = await deps.loops.failure({ companyId: t.companyId, ticketId, agentId: t.assigneeAgentId, text: v.timedOut ? `timeout: ${command}` : v.output, what: "The check" });
        const facts = checkFailureFacts(v.output);
        // The failing lines come from the whole kept log when there is one: the tail often starts after the failure.
        const whole = v.keptLog ? ((await queue.readLog(t.companyId, ticketId, v.keptLog.jobId).catch(() => null))?.log ?? null) : null;
        await keepBounce(gateBounceRecord({ command, why, output: whole ?? v.output, jobId: v.keptLog?.jobId, ticketId }));
        const delivered = await sendBack(`The review was approved, but the check \`${command}\` ${why}, so the ticket can't be merged yet. Fix it, then move the ticket back to review. If the failure isn't caused by your branch (the same step fails on main, or the check itself is broken), don't change your code: tell the CEO, who marks the ticket fixing the check (update_ticket fixesMergeCheck), then move this ticket back to review on the same commit; its approvals and sign-off are kept and it waits, held, for that fix.${facts ? `\n\nWhat failed: ${facts}.` : ""}\n\nLast output:\n${v.output.slice(-4000)}${v.keptLog ? `\n\n${fullLogPointer(v.keptLog.jobId, v.keptLog.ticketId, v.keptLog.chars)}` : ""}${loop.circular ? DIFFERENT_APPROACH(loop.count) : ""}`, "verify failed");
        return { outcome: "verify_failed", delivered, detail: v };
      };
      // BOS-313 (F6): with the setting on, the checks run on the merge commit that will be pushed, inside the merge itself.
      // BOS-316 (DR-003): in server mode the merged result is checked by a job in the check queue, not inside the merge request.
      const checkPrio = await ticketCheckPriority(db, t); // BOS-1403: urgent/arch fix 0, ordinary 1, background lane 2
      const serverChecks = landing !== "pull_request" && checks.length > 0 && (await queue.mode()) === "server";
      const checkMerged = !serverChecks && landing !== "pull_request" && checks.length > 0 && (await checkMergedResult());

      // BOS-1070: with the owner's switch on, a GitHub project's merge also waits for GitHub CI on the exact merge commit.
      // The gate pushes that commit to bossman-ci/<ticket>, reads its Actions runs (BOS-1630), and merges only on green.
      // Everything here sits behind the switch: off, the flow below is unchanged.
      let ci: { cfg: GitHostConfig; token: string } | null = null;
      if (!opts?.skipChecks && landing !== "pull_request" && gitHost === "github" && deps.gitHosts && (await waitForCi())) {
        if (!deps.runners.can(runner.id, "ci-publish")) {
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: "Waiting for GitHub CI is on, but this company's runner is too old to push the merge for CI, so this merge goes ahead on Boss Man's own check only. Update the runners: Settings → Server and runner → Updates → Build and update runners." });
        } else {
          ci = await prTarget(t.companyId, repoUrl, gitHost, gitApiBase).catch((err: Error) => {
            throw new ReviewError(409, `Waiting for GitHub CI is on, but Boss Man can't read GitHub for this project: ${err.message}`);
          });
        }
      }
      // The push and the read live in ci-publish.ts (BOS-1664), where the pre-flight run reuses them.
      const publishAndWait = (prep: { commit: string; tree: string; targetSha: string }, stop: CiStop): Promise<CiOutcome> =>
        ciPublishAndWait(
          {
            hosts: deps.gitHosts!,
            target: ci!,
            timing: ciTiming,
            passedTrees: ciPassedTrees,
            // BOS-1664: the runner scans before this push with the owner's list too (a runner without "ci-publish-scan" drops the field).
            publish: async (commit) => {
              const scanList = await scanListWarning.forScan();
              return ask<MergeResult>((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: "publish for CI", phase: "publish", commit, ...(scanList ? { scanList } : {}) }), MERGE_WAIT_MS);
            },
            announce: async (branch) => {
              await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `Pushed the merge commit ${prep.commit.slice(0, 12)} to ${branch} for GitHub CI; Boss Man's own check runs at the same time. Nothing to do.` });
            },
            announceRerun: async (commit) => {
              await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub cancelled the CI run for ${commit.slice(0, 12)} and no newer run replaced it, so Boss Man asked GitHub to run it once more. Nothing to do.` });
            },
            onWait: (s) => (s ? ciWaits.set(ticketId, s) : ciWaits.delete(ticketId)),
            touch,
          },
          prep,
          stop,
        ).catch((err: Error) => {
          throw err instanceof CiPublishError ? new ReviewError(409, err.message) : err;
        });
      // Other tickets in this project that waited on an open CI card: CI can be read again, so start them.
      const startCiWaiters = () => {
        const held = ciCardWaiting.get(t.projectId);
        if (!held) return;
        ciCardWaiting.delete(t.projectId);
        for (const id of held) {
          if (id === ticketId) continue;
          void approvedAndWaiting(id)
            .then((ok) => (ok ? this.startLanding(id, "Boss Man (GitHub CI can be read again)") : undefined))
            .catch(() => undefined);
        }
      };
      // One owner card per project for what only the owner can fix (the token, the GitHub bill); other tickets wait on it.
      const ciCard = async (why: "access" | "billing" | "error", message: string): Promise<LandOnceResult> => {
        const switchOff = `To stop waiting for GitHub CI instead, turn off "Wait for GitHub CI" in Settings → Server and runner → Checks, then choose "${CHECK_AGAIN}".`;
        const question =
          why === "access"
            ? `GitHub CI: the company's git token can't read GitHub Actions runs (${message}), so Boss Man can't tell whether CI passed. Nothing in this project merges until it can. To fix it on GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens → open the token Boss Man uses → Repository permissions → Actions: Read-only (Metadata: Read-only is set with it) → Update token. Then choose "${CHECK_AGAIN}". ${switchOff}`
            : why === "billing"
              ? `GitHub CI didn't run for "${t.title}": GitHub wouldn't start its jobs because of the account's spending limit or a failed payment. This isn't a problem with the agent's work. To fix it on GitHub: Settings → Billing and licensing → check the payment method and the Actions budget. Then choose "${CHECK_AGAIN}". ${switchOff}`
              : `GitHub CI: Boss Man couldn't read the CI result for "${t.title}" from GitHub after several tries (${message}), so nothing was merged. If GitHub is having trouble (githubstatus.com), wait for it to recover, then choose "${CHECK_AGAIN}". ${switchOff}`;
        const raised = await raiseCheckStuck(db, t, "GitHub CI", why === "access" ? "couldn't read GitHub Actions runs" : why === "billing" ? "wasn't started by GitHub (billing)" : "couldn't be read from GitHub", message, { question, tier: "owner", dedupeKey: `ci-${why}:${t.projectId}` });
        if (raised === null) {
          const held = ciCardWaiting.get(t.projectId) ?? new Set<string>();
          held.add(ticketId);
          ciCardWaiting.set(t.projectId, held);
        }
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `Not merged: ${why === "access" ? "the git token can't read GitHub Actions runs" : why === "billing" ? "GitHub didn't start CI (billing)" : "GitHub's CI result couldn't be read"} (${message.slice(0, 200)}). ${raised === null ? "It waits on the card already open for this project and starts again when it's answered." : "It's in the owner's Decisions."}` });
        return { outcome: "check_stuck", delivered: null, detail: { ci: why, message } };
      };
      // What a CI wait means for this attempt: null carries on to the merge, anything else ends it.
      const ciVerdict = async (o: CiOutcome, prep: { commit: string; tree: string }): Promise<LandOnceResult | null> => {
        switch (o.kind) {
          case "stopped":
            return null;
          case "passed":
            if (!o.reused) {
              ciPassedTrees.add(prep.tree);
              if (ciPassedTrees.size > 500) ciPassedTrees.delete(ciPassedTrees.values().next().value!);
              await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: prep.commit, kind: "ci", passed: true, detail: null });
            }
            startCiWaiters();
            return null;
          case "no_workflows":
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: "The merged result has no GitHub workflows, so there is no GitHub CI to wait for; it merges on Boss Man's own check." });
            return null;
          case "none":
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub CI didn't start for this push within ${Math.round(ciTiming.graceMs / 60_000)} minutes (the repo's workflow may not run on bossman-ci/** branches), so it merges on Boss Man's own check only.` });
            startCiWaiters();
            return null;
          case "timeout": {
            const mins = Math.round(ciTiming.ceilingMs / 60_000);
            await raiseCheckStuck(db, t, "GitHub CI", `was still running after ${mins} minutes${o.waiting.length ? ` (${o.waiting.join(", ")})` : ""}`, "");
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `Not merged: GitHub CI was still running after ${mins} minutes; it's in your Decisions.` });
            return { outcome: "check_stuck", delivered: null, detail: { ci: "timeout", waiting: o.waiting } };
          }
          case "superseded":
            // A newer push to the CI branch replaced this run: not a failure. Start the attempt again on the current main.
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub cancelled the CI run for ${prep.commit.slice(0, 12)} because a newer run on the same branch (${o.newerSha.slice(0, 12)}) replaced it. No test failed; the merge starts again. Nothing to do.` });
            return { outcome: "lock_wait", delivered: null, detail: { status: "ci_superseded", newerSha: o.newerSha } };
          case "cancelled": {
            const what = o.runs.join(", ") || "the CI run";
            await raiseCheckStuck(db, t, "GitHub CI", `was cancelled on GitHub (${what})${o.rerunTried ? ", and cancelled again after one re-run" : "; Boss Man's token couldn't re-run it (it needs Actions: Read and write)"}. No test failed. Open the run on GitHub and re-run it, then choose "${CHECK_AGAIN}"`, "");
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `Not merged: GitHub cancelled the run (${what}); no test failed. It's in your Decisions.` });
            return { outcome: "check_stuck", delivered: null, detail: { ci: "cancelled", runs: o.runs } };
          }
          case "refused":
            return ciCard("access", o.message);
          case "error":
            return ciCard("error", o.message);
          case "failed": {
            startCiWaiters();
            const found = await deps.gitHosts!.failures(ci!.cfg, ci!.token, o.status.failed).catch(() => []);
            if (o.status.billing || found.some((f) => f.billing)) return ciCard("billing", o.status.failed.map((r) => r.name).join(", ") || "jobs not started");
            const jobs = o.status.failed.map((r) => r.name);
            const listed = found.length ? found : o.status.failed.map((run) => ({ run, lines: [] as string[] }));
            // The agent can't read GitHub's logs and never holds the token, so the server reads each failed job's log (BOS-1667).
            const logs = new Map<number, string[]>();
            for (const f of listed.slice(0, 5)) if (f.run.id) logs.set(f.run.id, await deps.gitHosts!.jobLogBlock(ci!.cfg, ci!.token, f.run.id));
            const body = listed.length
              ? listed
                  .map((f) => {
                    const log = logs.get(f.run.id);
                    return `- ${f.run.name}${f.run.url ? ` (${f.run.url})` : ""}${f.lines.length ? `\n${f.lines.map((l) => `  - ${l}`).join("\n")}` : ""}${log ? `\n  Log lines (secrets redacted):\n${log.map((l) => `  > ${l}`).join("\n")}` : ""}`;
                  })
                  .join("\n")
              : "- the workflow failed before any job ran; open the commit's checks on GitHub";
            // As for the gate's own check (checkFailed, BOS-1173): a merge-check fix marked, or a waits-on link added, while
            // CI ran means the failure is main's until that fix is in force (BOS-1643). The throw ends the attempt held, the
            // way checkFailed's does: ciVerdict is awaited inside alongsideCi / ciThenChecked, so it reaches the landing.
            const waiting = await holdForWaits(ticketId);
            if (waiting) throw waiting;
            await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: prep.commit, kind: "ci", passed: false, detail: (jobs.join(", ") || "workflow failed").slice(0, 500) });
            await keepBounce(ciBounceRecord({ commit: prep.commit, target: defaultBranch, body }));
            const loop = await deps.loops.failure({ companyId: t.companyId, ticketId, agentId: t.assigneeAgentId, text: body, what: "GitHub CI" });
            const delivered = await sendBack(
              `The review was approved, but GitHub CI failed on the merge of your branch with ${defaultBranch} (commit ${prep.commit.slice(0, 12)}), so it can't be merged yet. Failed:\n${body}\n\nFix it on your branch (merge origin/${defaultBranch} in if the failure comes from the two together), run the checks${verifyCommand ? ` (\`${verifyCommand}\`)` : ""}, commit, then move the ticket back to review.${loop.circular ? DIFFERENT_APPROACH(loop.count) : ""}`,
              "ci failed",
            );
            return { outcome: "verify_failed", delivered, detail: { ci: "failed", jobs } };
          }
        }
      };
      type Early = { status: "early"; result: LandOnceResult };
      // The gate's own check and the CI wait side by side. Whichever ends the attempt first (a failure) stops the other;
      // its later result is dropped, so the ticket is never sent back twice.
      const alongsideCi = async <O extends object>(prep: { commit: string; tree: string; targetSha: string }, own: (stop: CiStop) => Promise<O | null>): Promise<O | Early | null> => {
        if (!ci) return own({ stopped: false });
        const stop: CiStop = { stopped: false };
        const ownP = own(stop).then(
          (r) => {
            if (r) stop.stopped = true;
            return r;
          },
          (e: unknown) => {
            // The gate's own check threw (the runner went away): stop the CI poll too, or it holds this landing for up to
            // the CI ceiling before the error reaches the retry.
            stop.stopped = true;
            throw e;
          },
        );
        const ciP = publishAndWait(prep, stop).then((o) => {
          if (ciStops(o)) stop.stopped = true;
          return o;
        });
        const first = await new Promise<"both" | "ci">((resolve) => {
          let n = 0;
          const one = () => void (++n === 2 && resolve("both"));
          ownP.then(one, () => {
            ciP.catch(() => undefined);
            resolve("both");
          });
          ciP.then((o) => (ciStops(o) ? resolve("ci") : one()), one);
        });
        if (first === "ci") {
          ownP.catch(() => undefined);
          const v = await ciVerdict(await ciP, prep);
          return v ? { status: "early", result: v } : null;
        }
        const r = await ownP;
        if (r) {
          ciP.catch(() => undefined);
          return r;
        }
        const v = await ciVerdict(await ciP, prep);
        return v ? { status: "early", result: v } : null;
      };

      // The project's checks on the branch, through the gate (legacy mode). Without CI they run here, before the merge, as
      // always; with CI they run inside the split merge below, beside the CI wait.
      const legacyChecks = async (stop: CiStop): Promise<LandOnceResult | null> => {
      for (const command of checkMerged || serverChecks ? [] : checks) {
        await touch();
        // Through the gate: at most N checks run at once. A runner that doesn't answer counts as an infra failure too.
        const runCheck = (alone: boolean) =>
          whileActive(() => {
            phases.set(ticketId, "queued");
            return timedCheck(named(command), "gate", (w) => gate.run(checkPrio, alone, w), checkVerdict, () => {
              phases.set(ticketId, "checking");
              return (async () => {
                const scanList = await scanListWarning.forScan();
                return ask<VerifyResult>((requestId) => ({ type: "workspace.verify", requestId, projectId: t.projectId, ticketId, command, ...(scanList ? { scanList } : {}) }), VERIFY_ASK_TIMEOUT_MS);
              })().catch((err: Error): VerifyResult & { noAnswer: true } => {
                // The runner went away mid-check: land() runs the merge again once it is back, without using the check retries.
                if (err instanceof RunnerGone) throw err;
                return { ok: false, exitCode: null, timedOut: false, output: err.message, ms: 0, noAnswer: true };
              });
            });
          });
        let v = await runCheck(false);
        // CI failed while this ran (BOS-1070): CI's send-back is the one the agent gets.
        if (stop.stopped) return null;
        // Killed, out of memory, timed out or no answer: the host was cut off, not the work. Run it again by itself,
        // keeping the ticket's place, before any card appears (BOS-446). The lock wait has its own retries in land().
        for (let retry = 1; !v.ok && !checkWaitedForLock(v); retry++) {
          const why: InfraCause | null = (v as { noAnswer?: boolean }).noAnswer ? "no_answer" : checkNeverFinished(v);
          if (!why || retry > INFRA_RETRY_ATTEMPTS) break;
          const pause = INFRA_RETRY_BASE_MS * 2 ** (retry - 1);
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The merge check ${INFRA_CAUSE_TEXT[why](v.ms)} before it finished; running it again (try ${retry} of ${INFRA_RETRY_ATTEMPTS}, in ${Math.max(1, Math.round(pause / 1000))}s${retry === INFRA_RETRY_ATTEMPTS ? ", on its own" : ""}). Nothing to do.` });
          await whileActive(() => new Promise((resolve) => setTimeout(resolve, pause)));
          const [now] = await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, ticketId));
          if (now?.state !== "review") return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while the merge check waited, so it was not retried." } };
          v = await runCheck(retry === INFRA_RETRY_ATTEMPTS);
          if (stop.stopped) return null;
        }
        await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: t.pullRequestHead, kind: kindOf(command), passed: v.ok, detail: v.ok ? null : v.output.slice(-500) });
        if (!v.ok) return checkFailed(named(command), v);
      }
      return null;
      };
      if (!ci) {
        const r = await legacyChecks({ stopped: false });
        if (r) return r;
      }

      // BOS-1540: no migration-number send-back here. The runner's merge renumbers a clashing branch itself
      // (BOS-690) and records migration_renamed; a clash it refuses comes back below as conflicts or migration_journal.

      // A pull request: the host must be known and reachable before anything is pushed (R59).
      const pr = landing === "pull_request" ? await prTarget(t.companyId, repoUrl, gitHost, gitApiBase) : null;
      // The runner does one git job per repo at a time, so a merge can queue behind other agents' fetches and
      // worktree set-ups before its own fetch and push; two minutes wasn't enough on a busy project. A merge
      // that finishes after this is still safe: trying again finds the branch already merged.
      await touch();
      phases.set(ticketId, "merging");
      type Stuck = { status: "job_stuck"; command: string; reason: string; output: string };
      type Prepared = Extract<MergeResult, { status: "prepared" }>;
      type CheckFailed = Extract<MergeResult, { status: "check_failed" }>;
      // "stopped": GitHub CI failed while the round's job ran (BOS-1070); CI's verdict is the attempt's answer.
      type RoundEnd = { status: "passed" } | { status: "stopped" } | { status: "branch_moved"; head: string; pinned: string } | { status: "restack"; why: RestackWhy } | Stuck | { status: "job_superseded" } | { status: "left_review" } | CheckFailed;
      const message = gateMergeMessage(t.title, ticketId);
      const retargetOn = async () => {
        // Never while CI gating is on (BOS-1070): CI was published for this commit, and a retargeted tree is one CI never ran on.
        if (ci) return false;
        const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MERGE_RETARGET_KEY));
        return row?.value !== false && row?.value !== "false";
      };
      // BOS-1365: one job per merge. Two jobs on one tree each waited for a slot and a quick merge landed in between. When the
      // deep check differs from the project check, one job runs both (project check first, with FULL_CHECK_NEXT so it skips what
      // the deep check repeats). The deep check is "also", never instead. skipChecks leaves `checks` empty, so nothing is queued.
      const queuedChecks = combinedCommand && checks.length > 1 ? [combinedCommand] : [...new Set(checks)];
      // base / expectBase only reach a runner that announced "merge-base" (the train checks that before it runs).
      const prepare = (base?: string) => askMerge((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message, phase: "prepare", ...(base ? { base } : {}) }), MERGE_WAIT_MS);
      const finish = (prep: Prepared, expectBase?: string) => askMerge((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message, phase: "finish", commit: prep.commit, tree: prep.tree, ...(expectBase ? { expectBase } : {}) }), MERGE_WAIT_MS);
      /**
       * One round: the merge's check job(s) on one prepared tree (BOS-316), waited on through their rows. `ref.prep` is that tree;
       * the BOS-1344 refresh may move it while the round's first job is still queued. `stale` (merge train, BOS-1366) is asked on
       * every poll: once it names a reason the round ends and the caller prepares again. Queueing the new tree then replaces a
       * queued job and keeps its place (BOS-1328); a running one is cancelled as a leftover, which frees its slot.
       */
      const runRound = async (ref: { prep: Prepared }, o: { refresh: () => Promise<boolean>; stale?: () => RestackWhy | null; onRetarget?: (p: Prepared) => void; train?: () => { place: number; ahead: number } | undefined; stop?: CiStop; leftReview?: () => Promise<boolean> }): Promise<RoundEnd> => {
        let lastRefresh = Date.now();
        for (const command of queuedChecks) {
          {
            let prep = ref.prep;
            const { job, reused } = await queue.enqueue({ companyId: t.companyId, projectId: t.projectId, ticketId, kind: "merge", scope: "full", commit: prep.commit, tree: prep.tree, command, priority: checkPrio });
            // BOS-1289: a merge that starts again after a restart has no waiter on the old process's job. It was adopted above when
            // the tree is the same; a job for another tree (main moved) is left over and would hold a slot beside this one.
            if (!reused && deps.cancelCheck) {
              const leftovers = await db.select({ id: checkJobs.id }).from(checkJobs).where(and(eq(checkJobs.ticketId, ticketId), eq(checkJobs.kind, "merge"), inArray(checkJobs.state, ["queued", "running"]), ne(checkJobs.id, job.id)));
              for (const o of leftovers) await deps.cancelCheck(o.id, SUPERSEDED_TEXT).catch(() => undefined);
            }
            // The merge-line record (BOS-769) takes the job's own start and end times; the poll only notices them.
            const line = { check: named(command), way: "queue" as const, jobId: job.id };
            const seat = o.train?.();
            await lineEvent(db, t, { event: "check_queued", ...line, ...(reused ? { reused: true } : {}), ...(seat ? { train: seat } : {}) });
            let seenStart = 0;
            const started = async (j: typeof job) => {
              if (j.startedAt && j.startedAt.getTime() !== seenStart) {
                seenStart = j.startedAt.getTime();
                // BOS-1435: where it runs, so the merge-line record shows a check that ran on a check worker.
                const ranOn = j.workerId ? ((await db.select({ name: checkWorkers.name }).from(checkWorkers).where(eq(checkWorkers.id, j.workerId)))[0]?.name ?? "a check worker") : "company runner";
                await lineEvent(db, t, { event: "check_started", ...line, ranOn }, j.startedAt);
              }
            };
            // An earlier pass of the same tree is reused as it is: it ran before this attempt, so only queued and ended are written, now.
            if (reused !== "passed") await started(job);
            let cur = job;
            while (cur.state === "queued" || cur.state === "running") {
              // GitHub CI failed meanwhile (BOS-1070): the job runs on (a pass is reused next time), but this attempt is over.
              if (o.stop?.stopped) {
                await lineEvent(db, t, { event: "check_ended", ...line, passed: null, why: "GitHub CI failed first; the job carries on and a pass is reused" });
                return { status: "stopped" };
              }
              await new Promise((resolve) => setTimeout(resolve, CHECK_JOB_POLL_MS));
              const [row] = await db.select().from(checkJobs).where(eq(checkJobs.id, cur.id));
              if (!row) {
                await lineEvent(db, t, { event: "check_ended", ...line, passed: null, why: "the check job disappeared from the queue" });
                return { status: "job_stuck", command, reason: "The check job disappeared from the queue.", output: "" };
              }
              cur = row;
              await started(cur);
              // The ticket left review (sent back, moved by hand) while its check waited or ran (BOS-1504 for the train, BOS-1757
              // and BOS-1769 for every path: a check for a ticket that can't merge must not hold a slot). The round ends; in the
              // train, trainMerge's `finally` then gives up the seat and the members behind restack. `leftReview` also counts a
              // ticket that went out and straight back (BOS-1769). The job is cancelled only while the ticket is still out of
              // review: one already back in review gets a new landing, which reuses this job on the same tree (enqueue's "live")
              // and keeps its place, so cancelling it here would fail that landing with "job stuck".
              if ((cur.state === "queued" || cur.state === "running") && (await (o.leftReview ?? leftReview)())) {
                if (!(await inReview())) await deps.cancelCheck?.(cur.id, "The ticket left review, so its merge check was stopped.").catch(() => undefined);
                await lineEvent(db, t, { event: "check_ended", ...line, passed: null, why: "the ticket left review" });
                return { status: "left_review" };
              }
              // Merge train: the base this tree was built on no longer holds. Leave the job to the next round (it replaces it).
              const why = cur.state === "queued" || cur.state === "running" ? o.stale?.() : null;
              if (why) {
                await lineEvent(db, t, { event: "check_ended", ...line, passed: null, why: `restacked: ${why}` });
                return { status: "restack", why };
              }
              // BOS-1344: still waiting for a slot. When main moved, the job takes the new merged tree before it starts, so the check
              // never begins on a tree that is already stale. A failed refresh (conflict, migration) is left to the normal round.
              // Only the round's first command: a later one would push a tree an earlier command never ran on (finish then says main_moved).
              if (command === queuedChecks[0] && cur.state === "queued" && Date.now() - lastRefresh >= MERGE_RETARGET_MS && (await o.refresh())) {
                lastRefresh = Date.now();
                const fresh = await prepare().catch(() => null);
                // BOS-1413: a commit made while the check waited for a slot: the queued job is dropped and nothing is merged.
                if (fresh?.status === "branch_moved") return fresh;
                if (fresh?.status === "prepared" && fresh.tree !== cur.tree) {
                  const moved = await queue.retarget(cur.id, { commit: fresh.commit, tree: fresh.tree });
                  // null: a runner claimed the job meanwhile, so it runs on the old tree and "finish" decides.
                  if (moved) {
                    prep = fresh;
                    ref.prep = fresh;
                    o.onRetarget?.(fresh);
                    cur = moved;
                    await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: "Main moved while the merge check waited, so the check now runs on the current main. Nothing to do." });
                  }
                }
              }
            }
            await lineEvent(db, t, { event: "check_ended", ...line, passed: cur.state === "passed" ? true : cur.state === "failed" ? checkVerdict({ ok: false, exitCode: cur.exitCode, timedOut: /timed out/i.test(cur.reason ?? ""), output: cur.logTail ?? "", ms: 0 }) : null, ...(cur.reason && cur.state !== "passed" ? { why: cur.reason.slice(0, 200) } : {}) }, reused === "passed" ? new Date() : (cur.endedAt ?? new Date()));
            if (cur.state === "passed") {
              await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: prep.commit, kind: kindOf(command), passed: true, detail: null });
              // A merge card left by an earlier attempt no longer applies once the check has passed.
              await clearMergeCards(db, ticketId, { by: "system", note: "The merge check has now passed, so this retry card is no longer needed.", at: new Date().toISOString() });
            }
            if (cur.state === "cancelled" && cur.reason === SUPERSEDED_TEXT) return { status: "job_superseded" };
            if (cur.state === "stuck" || cur.state === "cancelled") return { status: "job_stuck", command, reason: cur.reason ?? `The check job was ${cur.state}.`, output: cur.logTail ?? "" };
            if (cur.state === "failed") {
              const chars = await queue.logChars(cur.id).catch(() => null);
              return { status: "check_failed", command, result: { ok: false, exitCode: cur.exitCode, timedOut: /timed out/i.test(cur.reason ?? ""), output: cur.logTail ?? "", ms: cur.startedAt && cur.endedAt ? cur.endedAt.getTime() - cur.startedAt.getTime() : 0, ...(chars ? { keptLog: { jobId: cur.id, chars, ticketId } } : {}) } };
            }
          }
        }
        return { status: "passed" };
      };
      type ServerMergeEnd = MergeResult | Stuck | { status: "job_superseded" } | { status: "left_review" } | { status: "handed_over" };
      // Merge train: the check that failed once, then passed its one re-run (a flaky test), named on the landing's result.
      let flakyCheck: string | null = null;
      // Server mode: build the merge commit, queue a merge job for its tree, wait on the job's row (and GitHub CI beside it when
      // on, BOS-1070), then push exactly what was checked.
      const serverMerge = async (): Promise<ServerMergeEnd | Early> => {
        // BOS-1371: the first round of an adopted merge uses the live job's commit and tree; any trouble falls back to a normal prepare.
        // The train doesn't adopt: it re-prepares, and the same tree reuses the live job through enqueue. Nor does CI gating: an
        // adopted commit was never published, so CI would start from scratch on it anyway, and a normal prepare does that.
        let adopted = ci ? undefined : opts?.adopt;
        for (let round = 0; round < 3; round++) {
          const prep: MergeResult = adopted ? { status: "prepared", commit: adopted.commit, tree: adopted.tree, targetSha: "" } : await prepare();
          if (prep.status !== "prepared") return prep;
          const wasAdopted = !!adopted;
          adopted = undefined;
          const ref = { prep };
          const r = await alongsideCi(prep, async (stop) => {
            const end = await runRound(ref, { refresh: retargetOn, stop, leftReview });
            return end.status === "passed" || end.status === "stopped" ? null : end;
          });
          if (r?.status === "restack") continue; // only the train restacks; kept for the type
          if (r) return r;
          // BOS-1769: the check (and CI) passed, but the ticket left review meanwhile: a pass that is over never pushes. A landing
          // started for its next pass reuses the passed job on the same tree.
          if (await leftReview()) return { status: "left_review" };
          await touch();
          phases.set(ticketId, "merging");
          // The runner may have lost the adopted commit (it restarted too): prepare again rather than fail. A runner that went away stays an error.
          const fin = wasAdopted ? await finish(ref.prep).catch((err: Error) => { if (err instanceof RunnerGone) throw err; return null; }) : await finish(ref.prep);
          if (fin && fin.status !== "main_moved") return fin;
        }
        return { status: "main_moved" };
      };
      // Legacy mode with CI gating (BOS-1070): the same split merge, with the branch's own checks beside the CI wait. Legacy
      // checks test the branch, not the merge, so a rebuilt merge (main moved) doesn't run them again.
      const legacyCiMerge = async (): Promise<MergeResult | Early> => {
        for (let round = 0; round < 3; round++) {
          const prep = await prepare();
          if (prep.status !== "prepared") return prep;
          const r = await alongsideCi(prep, async (stop): Promise<Early | null> => {
            if (round > 0) return null;
            const own = await legacyChecks(stop);
            return own ? { status: "early", result: own } : null;
          });
          if (r) return r;
          await touch();
          phases.set(ticketId, "merging");
          const fin = await finish(prep);
          if (fin.status !== "main_moved") return fin;
        }
        return { status: "main_moved" };
      };
      // "Check merged result" without the queue: the runner checks inside one merge call, so CI goes first, then the merge
      // may push only the tree CI passed (expectTree). One after the other here; the parallel case is the server queue.
      const ciThenChecked = async (): Promise<MergeResult | Early> => {
        const prep = await prepare();
        if (prep.status !== "prepared") return prep;
        const v = await ciVerdict(await publishAndWait(prep, { stopped: false }), prep);
        if (v) return { status: "early", result: v };
        return plainOrChecked(prep.tree);
      };
      function plainOrChecked(expectTree?: string) {
        return whileActive(() =>
          (checkMerged
            ? (w: () => Promise<MergeResult>) =>
                timedCheck(checks.map(named).join(" && "), "merged", (x) => gate.run(checkPrio, false, x), (r) => (r.status === "merged" ? true : r.status === "check_failed" ? checkVerdict(r.result) : null), w)
            : (w: () => Promise<MergeResult>) => w())(() => askMerge(
            (requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: gateMergeMessage(t.title, ticketId), ...(checkMerged ? { checks } : {}), ...(expectTree ? { expectTree } : {}) }),
            // The runner may check up to three merged results, one after another.
            checkMerged ? MERGE_WAIT_MS + 3 * checks.length * VERIFY_ASK_TIMEOUT_MS : MERGE_WAIT_MS,
          )),
        );
      }
      /**
       * Merge train (BOS-1366, DR-059): seated in line order with up to one member per check slot, prepared on main plus the
       * members ahead, checked, and landed only as the head, with finish's expectBase = the base it was prepared on. The runner
       * refuses any other push, so a wrong train costs checks, never main. Notes on the rules:
       * - a stacked prepare that isn't clean (a clash with a member ahead that may never land) is not sent back: the ticket
       *   re-joins as head only and gets the real answer on main alone, unless it already clashes with main alone (asked at
       *   once, BOS-1518), which sends it back without waiting;
       * - a failed check counts only once every member ahead has passed (attribution); a stale member restacks instead, uncharged;
       * - a failure that stands runs once more on the same tree (a flaky test then costs one check, no restarts behind);
       *   killed, timed-out or unanswered checks keep today's handling;
       * - any exit that isn't a landing leaves the train (finally), so a seat is never held by a dead landing.
       */
      const trainMerge = async (): Promise<ServerMergeEnd | Early> => {
        // BOS-1435: seats grow with ready check workers; a worker that drops shrinks them, and admit never evicts a seated member.
        const { train, created } = trainFor(t.projectId, deps.checkCapacity ? await deps.checkCapacity(t.companyId) : await queue.slots());
        if (created) {
          // BOS-1289: the first landing after a server start seeds the old order from the merge jobs still live, ordered the way
          // admit orders (tier, then place: BOS-1504), so a background-lane ticket isn't seated right behind the head.
          train.seedOrder(await queue.liveMergeOrder(t.projectId));
        }
        const pl = await queue.place(ticketId);
        // BOS-1403 tiers: urgent/fix 0, ordinary 1, background lane 2; a ticket at the front of the line counts as 0.
        const at = { priority: pl.front ? 0 : checkPrio, place: (pl.at ?? new Date()).getTime() };
        const pause = () => new Promise((resolve) => setTimeout(resolve, CHECK_JOB_POLL_MS));
        const seatOf = () => {
          const p = train.place(ticketId);
          return p ? { place: p.place, ahead: p.ahead.length } : undefined;
        };
        // False once the cap is reached: the caller returns main_moved, `finally` gives up the seat (the members behind restack
        // without it and carry on) and land()'s back-off tries this ticket again later (Brains' build point 3).
        const restack = async (why: RestackWhy): Promise<boolean> => {
          const ok = train.restack(ticketId);
          const restacks = train.list().find((m) => m.ticketId === ticketId)?.restacks ?? 0;
          await lineEvent(db, t, { event: "restacked", why: ok ? why : "cap", restacks });
          return ok;
        };
        // A copy that is no longer in charge (blue/green hand-over, BOS-1289) stops: the server in charge rebuilds its own train.
        const gone = async (): Promise<ServerMergeEnd | null> => {
          if (deps.isLeader && !deps.isLeader()) return { status: "handed_over" };
          return (await leftReview()) ? { status: "left_review" } : null;
        };
        let headOnly = false;
        let clash: TrainClash | null = null;
        // BOS-1515 (B2): while it waits, a read-only merge on main after main moves. A clash there is certain (the gate's own
        // tryMerge, renumbering included), so it goes back now, not when it gets a seat. Null (can't tell) never sends it back.
        let triedGen = -1;
        let triedAt = 0;
        const trialClash = async (): Promise<string[] | null> => {
          const gen = mainGen(t.projectId);
          const nowMs = Date.now();
          const due = (gen !== triedGen && nowMs - triedAt >= TRAIN_TRIAL_MIN_MS) || nowMs - triedAt >= TRAIN_TRIAL_FALLBACK_MS;
          if (!due) return null;
          triedGen = gen;
          triedAt = nowMs;
          return clashOnMain(t, defaultBranch);
        };
        try {
          seat: for (;;) {
            train.join(ticketId, { ...at, headOnly, clash });
            let held = false;
            while (!train.seated(ticketId)) {
              if (!held) {
                held = true;
                await lineEvent(db, t, { event: "hold_started", hold: "train", note: headOnly ? "waiting to land on main alone, after the merge train ahead" : "waiting for a place in the merge train" });
              }
              await pause();
              {
                const stop = await gone();
                if (stop) return stop;
              }
              // BOS-1516: Priority 1 set (or Move to front) after this ticket joined: the tier was fixed at join, so read it again.
              // A copy that missed the owner's switch (another server copy, a restart) still picks it up here.
              {
                const [mark] = await db.select({ urgent: tickets.urgent }).from(tickets).where(eq(tickets.id, ticketId));
                if (mark?.urgent) train.retier(ticketId, 0);
              }
              const onMain = await trialClash();
              if (onMain) {
                await lineEvent(db, t, { event: "train_clash", on: "main", with: clash ? await namedTickets(clash.with) : [], files: onMain.slice(0, TRAIN_CLASH_FILES), fileCount: onMain.length, action: "sent_back" });
                train.leave(ticketId);
                return { status: "conflicts", files: onMain };
              }
              // The owner turned the train off meanwhile: land the way it did before.
              if (!(await queue.train())) {
                train.leave(ticketId);
                return serverMerge();
              }
            }
            // A stacked prepare that came back main_moved: its base isn't on main any more. Wait for a new base rather than spin.
            let badBase: string | null = null;
            let again = false;
            for (;;) {
              // BOS-1604: the owner turned the train off. A member about to prepare again holds no checked tree, so it leaves
              // and lands the way it did before, like one still waiting for a seat. Before this, a seated member kept restacking
              // until the cap (with the back-off, up to ~20 min). A member with a passed check never gets here, so it keeps its base.
              if (again && !(await queue.train())) {
                train.leave(ticketId);
                return serverMerge();
              }
              again = true;
              // BOS-1604: a member restacking again and again before any check could run backs off instead of re-preparing
              // every poll (the train's thrash fact raises one alarm meanwhile). It still leaves at once if it leaves review.
              for (const until = Date.now() + train.backoffMs(ticketId); Date.now() < until; ) {
                await pause();
                const stop = await gone();
                if (stop) return stop;
              }
              let b = train.baseFor(ticketId);
              while (b.wait || (badBase !== null && b.base === badBase)) {
                await pause();
                {
                const stop = await gone();
                if (stop) return stop;
              }
                b = train.baseFor(ticketId);
              }
              const prep = await prepare(b.base ?? undefined);
              if (prep.status === "main_moved" && b.base) {
                badBase = b.base;
                continue;
              }
              badBase = null;
              if (prep.status !== "prepared") {
                if (b.base && prep.status !== "uncommitted") {
                  // Not clean on the tickets ahead: maybe theirs, not this ticket's. BOS-1518: ask main alone now (a merge-tree,
                  // no check job, the same call the head makes). A clash with main itself is the real answer, so it goes back at
                  // once instead of holding the line until the train drains; only a clash with the tickets ahead waits as head
                  // only. main_moved isn't an answer, so that case waits too (fails safe).
                  const alone = await prepare();
                  if (alone.status !== "prepared" && alone.status !== "main_moved") return alone;
                  // That was a try on main just now: the waiting trial starts from here.
                  if (alone.status === "prepared") {
                    [triedGen, triedAt] = [mainGen(t.projectId), Date.now()];
                    train.onMain(alone.targetSha);
                  }
                  // BOS-1515 (B1): say so on the merge line, naming the members ahead (the stacked base holds all of them) and
                  // the files. Not a passive event, so it closes the seat hold and the land-alone wait below is a hold of its own.
                  const ahead = train.place(ticketId)?.ahead ?? [];
                  const files = "files" in prep && Array.isArray(prep.files) ? (prep.files as string[]) : [];
                  clash = { with: ahead, files: files.slice(0, TRAIN_CLASH_FILES), at: Date.now() };
                  await lineEvent(db, t, { event: "train_clash", on: "ahead", with: await namedTickets(ahead), files: clash.files, fileCount: files.length, action: "land_alone" });
                  train.leave(ticketId);
                  headOnly = true;
                  continue seat;
                }
                return prep;
              }
              // onMain: prepared on main, so targetSha is main's tip and can never be a lost commit (BOS-1604).
              train.prepared(ticketId, { base: prep.targetSha, commit: prep.commit, tree: prep.tree, onMain: !b.base });
              const ref = { prep };
              const round = () =>
                runRound(ref, {
                  // Only the head refreshes on a moved main (BOS-1344): the others are built on the member ahead, not on main.
                  refresh: async () => train.isHead(ticketId) && (await retargetOn()),
                  stale: () => train.stale(ticketId),
                  // Only the head retargets, and its refresh prepares on main.
                  onRetarget: (f) => train.retargeted(ticketId, { base: f.targetSha, commit: f.commit, tree: f.tree, onMain: true }),
                  train: seatOf,
                  leftReview,
                });
              let r = await round();
              if (r.status === "check_failed") {
                train.failed(ticketId);
                let verdict = train.failure(ticketId);
                while (verdict === "wait") {
                  await pause();
                  {
                const stop = await gone();
                if (stop) return stop;
              }
                  verdict = train.failure(ticketId);
                }
                if (verdict === "restack") {
                  // A member ahead failed or changed: this failure may be theirs. Again without them, nothing charged.
                  if (!(await restack(train.stale(ticketId) ?? "ahead_changed"))) return { status: "main_moved" };
                  continue;
                }
                // The failure stands. Killed, timed out or unanswered keep today's handling; anything else runs once more.
                const infra = r.result.timedOut || (r.result as { noAnswer?: boolean }).noAnswer || checkNeverFinished(r.result) !== null;
                if (infra || !train.rerun(ticketId)) return r;
                const failedCheck = named(r.command);
                const failedJob = r.result.keptLog?.jobId;
                r = await round();
                await lineEvent(db, t, { event: "rerun", check: failedCheck, passed: r.status === "passed" ? true : r.status === "check_failed" ? false : null, ...(failedJob ? { failedJobId: failedJob } : {}) });
                if (r.status === "passed") flakyCheck = failedCheck;
                if (r.status === "passed") await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The merge check \`${failedCheck}\` failed, then passed when run again on the same tree: a flaky failure. It is counted in the merge-line record. Nothing to do.` });
              }
              if (r.status === "restack") {
                if (!(await restack(r.why))) return { status: "main_moved" };
                continue;
              }
              // The train never runs with CI gating, so nothing stops its rounds; never read "stopped" as a pass.
              if (r.status === "stopped") throw new Error("A merge-train check round was stopped by a CI wait that the train doesn't run.");
              if (r.status !== "passed") return r;
              train.passed(ticketId);
              // Land only as the head, on exactly the base this tree was prepared on.
              let why = train.stale(ticketId);
              while (!why && !train.isHead(ticketId)) {
                await pause();
                {
                const stop = await gone();
                if (stop) return stop;
              }
                why = train.stale(ticketId);
              }
              if (why) {
                if (!(await restack(why))) return { status: "main_moved" };
                continue;
              }
              await touch();
              const fin = await finish(ref.prep, ref.prep.targetSha);
              if (fin.status === "merged") {
                train.landed(ticketId);
                return fin;
              }
              if (fin.status === "main_moved") {
                // Something landed outside the train (a hand merge, a ticket on the old path): prepare again on main.
                if (!(await restack("main_moved"))) return fin;
                continue;
              }
              return fin;
            }
          }
        } finally {
          train.leave(ticketId);
        }
      };
      // Train mode (BOS-1366): the owner's switch, a runner that honours base/expectBase, and a green main. A red main keeps
      // today's path, so the fix for main never waits behind a train whose jobs the red main holds back.
      // Not with CI gating on (BOS-1070): CI is published only for a commit prepared on main, so with both switches on a
      // merge takes the one-at-a-time path, where CI runs beside the check job.
      const trainMode =
        !ci &&
        serverChecks &&
        queuedChecks.length > 0 &&
        // Only the server in charge builds a train (BOS-1289); a standby's landing keeps today's path.
        (!deps.isLeader || deps.isLeader()) &&
        (await queue.train()) &&
        deps.runners.can(runner.id, "merge-base") &&
        (await db.select({ s: projects.mainState }).from(projects).where(eq(projects.id, t.projectId)))[0]?.s !== "red";
      const m1: MergeResult | PushResult | ServerMergeEnd | Early = serverChecks
        ? await whileActive(trainMode ? trainMerge : serverMerge)
        : pr
        ? await whileActive(() => askMerge<PushResult>((requestId) => ({ type: "workspace.push", requestId, projectId: t.projectId, ticketId, target: defaultBranch }), MERGE_WAIT_MS))
        : ci && checkMerged
        ? await whileActive(ciThenChecked)
        : ci
        ? await whileActive(legacyCiMerge)
        : await plainOrChecked();
      // The attempt ended inside the split merge (BOS-1070): CI failed or couldn't be read, or the legacy check failed.
      if (m1.status === "early") return m1.result;
      // The ticket left review while its merge waited (in or for the train, or on its check job: BOS-1757, BOS-1769); nothing was pushed.
      if (m1.status === "left_review") return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while its merge check waited or ran, so nothing was merged." } };
      if (m1.status === "handed_over") return { outcome: "check_stuck", delivered: null, detail: { note: "Handed over while the merge waited in the merge train; the server now in charge restarts it." } };
      const m0 = m1;
      // BOS-1413: the branch got a commit the reviews never covered. Nothing was pushed; the queued check is dropped, the sign-off
      // card (if any) is withdrawn and the ticket goes back to its author, then to a new review round.
      if (m0.status === "branch_moved") {
        const was = m0.pinned.slice(0, 8);
        const now = m0.head ? m0.head.slice(0, 8) : "an unknown commit (the runner is too old to say; it needs updating)";
        if (deps.cancelCheck) {
          const queued = await db.select({ id: checkJobs.id }).from(checkJobs).where(and(eq(checkJobs.ticketId, ticketId), eq(checkJobs.kind, "merge"), inArray(checkJobs.state, ["queued", "running"])));
          for (const o of queued) await deps.cancelCheck(o.id, SUPERSEDED_TEXT).catch(() => undefined);
        }
        await supersedeSignoffs(db, ticketId, { by: "system", note: `The branch changed during the merge (${was} to ${m0.head ? now : "another commit"}).`, at: new Date().toISOString() });
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_failed", summary: `Not merged: the branch changed from ${was} to ${now} after the approval, and the reviewers haven't seen the new code. The ticket was sent back for a new review.` });
        const delivered = await sendBack(`The review was approved on ${was}, but the branch is now at ${now}: a commit was made after the approval, so nothing was merged. If the new work is meant to go in, make sure it is committed, then move the ticket back to review for a new review round and sign-off.`, "branch changed after approval");
        return { outcome: "branch_changed", delivered, detail: m0 };
      }
      // Replaced by a newer request of this ticket: that one is the live check and raises its own card if it fails, so no card here.
      if (m0.status === "job_superseded") {
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: "An older merge check request was dropped because a newer commit of this ticket was queued; the newer check carries on. Nothing to do." });
        return { outcome: "check_stuck", delivered: null, detail: { note: "A newer check of this ticket replaced this one; it carries on." } };
      }
      if (m0.status === "job_stuck") {
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The queued merge check stopped before it finished: ${m0.reason}` });
        await raiseCheckStuck(db, t, named(m0.command), `stopped: ${m0.reason}`, m0.output);
        return { outcome: "check_stuck", delivered: null, detail: m0 };
      }
      const m: MergeResult | PushResult = m0;
      if (m.status === "prepared" || m.status === "published" || m.status === "unpublished") throw new ReviewError(409, "The runner answered the merge with an unfinished step; try again.");
      if (m.status === "check_failed") {
        await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: t.pullRequestHead, kind: kindOf(m.command), passed: false, detail: m.result.output.slice(-500) });
        return checkFailed(named(m.command), m.result);
      }
      // The target kept moving while the merged result was checked; nothing was pushed, so land() tries again.
      if (m.status === "main_moved") return { outcome: "lock_wait", delivered: null, detail: m };
      // Target content showing in the copy (BOS-1231): never offered to the author to commit, which would put other tickets'
      // code on this branch and reset its approvals. The ticket stays in review with the reason; the CEO hears once per reason,
      // and the sweep's merge-stuck card carries it after its one retry.
      if (m.status === "uncommitted" && m.foreign?.length) {
        const note = `Not merged: the ticket's copy on the runner has changes to ${m.foreign.length} file${m.foreign.length > 1 ? "s" : ""} that ${defaultBranch} changed and this branch never touched (${m.foreign.slice(0, 10).join(", ")}${m.foreign.length > 10 ? ", …" : ""})${m.files.length ? `, besides its own uncommitted ${m.files.join(", ")}` : ""}. They aren't this ticket's work, so the author wasn't asked to commit them. The branch itself is unchanged.`;
        if (note !== t.pullRequestNote) {
          await db.update(tickets).set({ pullRequestNote: note }).where(eq(tickets.id, ticketId));
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_failed", summary: note });
          await tellCeo(t, "copy not clean", `${note} Have the author put the copy back to its branch head without committing those files (git status there shows them), then retry the merge.`).catch(() => undefined);
        }
        return { outcome: "uncommitted", delivered: null, detail: m };
      }
      if (m.status === "uncommitted") {
        const tpl = (await templates(t.companyId)).commit;
        const delivered = await sendBack(`The review was approved, but these files aren't committed: ${m.files.join(", ")}. ${renderTemplate(tpl, { branch: t.branch ?? `bossman/${t.id}`, base_ref: defaultBranch, ticket: t.title })} Then move the ticket back to review.`, "commit");
        return { outcome: "uncommitted", delivered, detail: m };
      }
      if (m.status === "migration_journal") {
        const delivered = await sendBack(`The review was approved, but the migration journal would make drizzle skip a migration, so nothing was merged. ${m.problems.join(" ")} Then run the checks${verifyCommand ? ` (\`${verifyCommand}\`)` : ""}, commit, and move the ticket back to review.`, "migration journal");
        return { outcome: "migration_journal", delivered, detail: m };
      }
      if (m.status === "conflicts") {
        const delivered = await sendBack(
          `The review was approved, but your branch conflicts with ${defaultBranch} in: ${m.files.join(", ")}.${"why" in m && m.why ? ` The gate tried to renumber the migration itself and refused: ${m.why}.` : ""} Merge origin/${defaultBranch} into your branch, resolve the conflicts keeping both sides' intent, run the checks${verifyCommand ? ` (\`${verifyCommand}\`)` : ""}, commit, then move the ticket back to review.`,
          "merge conflicts",
        );
        return { outcome: "conflicts", delivered, detail: m };
      }
      if (m.status === "pushed" && pr) {
        let opened;
        try {
          opened = await deps.gitHosts!.open(pr.cfg, pr.token, {
            head: m.branch,
            base: defaultBranch,
            title: t.title,
            body: `${t.body?.trim() ? `${t.body.trim()}\n\n` : ""}Opened by Boss Man for ticket ${t.id}, approved by ${reviewer}.`,
          });
        } catch (err) {
          throw new ReviewError(502, err instanceof GitHostError ? err.message : `Couldn't reach the git host: ${(err as Error).message}`);
        }
        await db.update(tickets).set({ pullRequestUrl: opened.url, pullRequestNumber: opened.number, pullRequestHead: m.commit, pullRequestNote: null }).where(eq(tickets.id, ticketId));
        return this.mergePullRequest(ticketId);
      }
      const checkedSha = m.status === "merged" ? m.checked?.sha : undefined;
      if (checkedSha) {
        for (const command of checks) await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: checkedSha, kind: kindOf(command), passed: true, detail: null });
      }
      await db.update(tickets).set({ mergeCommit: m.commit, ...(checkedSha ? { checkedCommit: checkedSha } : {}) }).where(eq(tickets.id, ticketId));
      // The CI branch has done its job (BOS-1070); deleted so the host doesn't collect one per merge. Best effort.
      if (ci && m.status === "merged") void ask<MergeResult>((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: "unpublish", phase: "unpublish" }), MERGE_WAIT_MS).catch(() => undefined);
      // BOS-690 (DR-037): the gate renumbered a clashing migration itself. One line, no wake, no card: nothing for anyone to do.
      if (m.status === "merged" && m.renamed?.length) {
        const names = m.renamed.map((r) => `${r.from} landed as ${r.to}`).join("; ");
        await record(db, { companyId: t.companyId, ticketId, kind: "migration_renamed", summary: `Migration ${names}; the SQL is unchanged, renamed by the merge gate because another ticket took the number first.` });
      }
      // BOS-316: what was pushed is exactly the tree a merge job just passed, so main passes its check (P11a).
      if (serverChecks && m.status === "merged") await queue.setMainState(t.projectId, "green", m.commit);
      // Its own after-merge checks keep this ticket open (DR-024 #5), but not the ones riding along.
      const mine = await closeAfterMerge(t, m.commit, causedByRunId, changed?.files.map((f) => f.path));
      for (const c of together) {
        await db.update(tickets).set({ mergeCommit: m.commit, lastActivityAt: new Date() }).where(eq(tickets.id, c.ticketId));
        await announceMerged(c.ticketId);
        // A fix riding along on this merge is just as live (BOS-639).
        const [rider] = await db.select().from(tickets).where(eq(tickets.id, c.ticketId));
        if (rider) await tellCeoLiveFix(rider, m.commit).catch(() => undefined);
        if (rider) await pagePriorityMerge(rider).catch(() => undefined);
        if (rider) await lineEvent(db, rider, { event: "merged", commit: m.commit });
        await deps.work.updateTicket(c.ticketId, { state: "done", outcome: "completed", overLimit: true });
      }
      // Merge train: a check that failed once and passed its re-run lands, but says so (Brains' build point 1).
      return { ...mine, delivered: mine.delivered, detail: flakyCheck && mine.detail && typeof mine.detail === "object" ? { ...(mine.detail as object), flaky: `The merge check \`${flakyCheck}\` failed once and passed when run again on the same tree: a flaky test.` } : mine.detail };
    },

    /**
     * Merges the ticket's pull request if the host allows it now (R59). If not (approvals or
     * status checks still needed, or someone else must merge), the ticket waits in review with
     * the host's reason; the sync tries again, and finishes the ticket if it's merged on the host.
     */
    async mergePullRequest(ticketId: string): Promise<{ outcome: "merged" | "pull_request"; delivered: string | null; detail?: unknown }> {
      const { t, repoUrl, defaultBranch, gitHost, gitApiBase } = await ticketWithRepo(ticketId);
      if (!t.pullRequestNumber) throw new ReviewError(409, "This ticket has no pull request.");
      if (t.systemState === "done") return { outcome: "merged", delivered: null };
      const { cfg, token } = await prTarget(t.companyId, repoUrl, gitHost, gitApiBase);
      // A hand-merge is the same merge as approval's: a branch carrying another open ticket's
      // unmerged work doesn't land here either (BOS-130).
      try {
        const now = await deps.gitHosts!.get(cfg, token, t.pullRequestNumber);
        // Already merged on the host (someone did it by hand): the ticket is finished, whatever the branch had.
        if (now.merged) return closeAfterMerge(t, now.mergeCommit);
        const others = (await otherOpenBranches(t)).filter((o): o is typeof o & { branch: string } => !!o.branch);
        const ids = await carriedOnHost(t, gitHost, gitApiBase, others);
        const carried = others.filter((o) => ids.includes(o.ticketId));
        if (carried.length) {
          const names = carried.map((o) => `"${o.title}"`).join(", ");
          return wait(t, `Not merged: this branch also carries unmerged work from ${names}, which must merge first. Nothing was merged.`);
        }
        if (now.closed) return wait(t, "The pull request was closed on the host without merging. Reopen it there, or approve the ticket again to open a new one.");
        // Only the reviewed commit is merged: anything pushed to the branch since needs a new review.
        const tried = await deps.gitHosts!.merge(cfg, token, t.pullRequestNumber, { headSha: t.pullRequestHead, title: `Merge "${t.title}" into ${defaultBranch}`, message: `Boss Man ticket ${t.id}.` });
        return tried.merged ? closeAfterMerge(t, tried.commit) : wait(t, tried.note);
      } catch (err) {
        if (err instanceof GitHostError) return wait(t, err.message);
        throw err;
      }
    },

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
        if (ceo) await wake?.(ceo.id, { ticketId, reason: "ci passed", note: `The checks passed on the pull request for "${t.title}", but it hasn't merged: ${t.pullRequestNote ?? "the host hasn't said why"}. Move it forward.` });
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

    waitForCi,
    async setWaitForCi(on: boolean) {
      await db.insert(settings).values({ key: WAIT_FOR_CI_KEY, value: on }).onConflictDoUpdate({ target: settings.key, set: { value: on } });
      return on;
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
