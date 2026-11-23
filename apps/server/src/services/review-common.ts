// The review service's top-level pieces (BOS-1901, move 1 of the BOS-1886 split): its error classes, the landing types, the
// retry and timing constants, and the helpers that need no service state. review.ts re-exports every name it exported before,
// so callers keep importing review.ts; only the review-* and merge-* parts import this file directly.
import { and, eq } from "drizzle-orm";
import { checkFailureFacts, checkFailureSentence, failingLines, formatDate, FULL_LOG_RETENTION_DAYS, fullLogPointer, redactForModel, RISK_TIERS, riskOf, type CarriedTicket, type RiskTier, type VerifyResult } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { decisions, tickets } from "../db/schema.js";
import { CI_TIMING } from "./ci-publish.js";
import { CEO_FIRST_MERGE_WHY, ceoFirstLadder, CHECK_AGAIN, CHECK_SEND_BACK, CHECK_SKIP, clearMergeCards } from "./decisions.js";
import { lineEvent } from "./merge-line.js";
import type { HoldWaitInput } from "./review-holds.js";

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
export type LandingView = (LandingStatus & { stale?: boolean; phase?: "queued" | "checking" | "merging" | "waiting_to_retry" | "retrying_git" }) | null;

/**
 * A check that was killed or timed out says nothing about the agent's work (the runner ran out of
 * memory, say), so it goes to the owner instead of back to the agent. Why it ended, or null if it
 * simply failed.
 */
export function checkNeverFinished(v: { timedOut: boolean; exitCode: number | null; output: string }): "timed_out" | "out_of_memory" | "killed" | null {
  const tail = v.output.slice(-4000);
  if (v.timedOut) return "timed_out";
  if (/JavaScript heap out of memory|out of memory|ENOMEM|Cannot allocate memory/i.test(tail)) return "out_of_memory";
  // BOS-2218: a test process that vitest lost to SIGKILL (the check itself ran to the end and failed one step) is the kernel's
  // out-of-memory kill; nothing in a test's own code sends SIGKILL to its worker. Seven such checks on 20 to 22 Nov.
  if (/Worker exited unexpectedly[^\n]*\bSIGKILL\b|\bSIGKILL\b[^\n]*Worker exited unexpectedly/i.test(tail)) return "out_of_memory";
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
/** BOS-2089: restart retries not counted while the runner settles after reconnecting (about 10 minutes of pauses and tries). */
export const SETTLE_FREE_TRIES = 8;
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
export const MERGE_RETARGET_MS = Number(process.env.BOSSMAN_MERGE_RETARGET_MS) > 0 ? Number(process.env.BOSSMAN_MERGE_RETARGET_MS) : 60_000;
/**
 * BOS-1821: a merge waiting for another ticket's landing turn asks again this often even when no gate push moved main (a push
 * from outside the gate). Tests set BOSSMAN_TURN_WAIT_RECHECK_MS to see the asks a gate push causes on their own.
 */
export const WAIT_RECHECK_MS = Number(process.env.BOSSMAN_TURN_WAIT_RECHECK_MS) > 0 ? Number(process.env.BOSSMAN_TURN_WAIT_RECHECK_MS) : 10 * MERGE_RETARGET_MS;
/** BOS-1820: at most this many CI-gated refreshes in one merge attempt (each restarts GitHub CI), a guard against a loop. */
export const MAX_CI_REFRESHES = 20;
/** The owner's off switch for refreshing a waiting merge (setting merge_retarget; on unless set to false). */
export const MERGE_RETARGET_KEY = "merge_retarget";
export const CHECK_JOB_POLL_MS = Number(process.env.BOSSMAN_CHECK_JOB_POLL_MS) > 0 ? Number(process.env.BOSSMAN_CHECK_JOB_POLL_MS) : 3000;
/** BOS-1733: the longest the gate waits for its re-run of GitHub's failed tests (queue and run); after it, no retry. */
export const FLAKE_RERUN_MAX_MS = 45 * 60_000;
/** BOS-1752: the flake re-run's answer on a copy that handed over (ciVerdict turns it into a quiet stop). */
export const HANDED_OVER_WHY = "this server copy handed over";
/**
 * BOS-1515 (B2): a ticket waiting in the merge train tries a merge on main (read-only) when main has moved since its last try,
 * at most once per TRAIN_TRIAL_MIN_MS (each try holds the project's repo lock for a fetch and a merge-tree), and at least every
 * TRAIN_TRIAL_FALLBACK_MS for merges made outside Boss Man. Tests shorten the first with BOSSMAN_TRAIN_TRIAL_MIN_MS.
 */
export const TRAIN_TRIAL_MIN_MS = Number(process.env.BOSSMAN_TRAIN_TRIAL_MIN_MS) > 0 ? Number(process.env.BOSSMAN_TRAIN_TRIAL_MIN_MS) : 30_000;
export const TRAIN_TRIAL_FALLBACK_MS = 10 * 60_000;
export const CHECK_MERGED_KEY = "check_merged_result";
/** BOS-1070: the owner's switch for waiting on the git host's CI before a merge. Off until they turn it on. */
export const WAIT_FOR_CI_KEY = "wait_for_ci";
/** BOS-1762: the owner's switch for landing a passed merge across a main move that touches none of its files. On unless set to false. */
export const MERGE_CARRY_KEY = "merge_carry";
/** BOS-1762: the landing turn's cap in minutes (0 = no landing turns). */
export const MERGE_TURN_KEY = "merge_turn_minutes";
export const MERGE_TURN_DEFAULT_MIN = 60;
export const MERGE_TURN_MAX_MIN = 240;
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
      // BOS-2301: an ending with a note (left review, handed over, replaced by a newer check) raises no card (merge-land.ts
      // counts it as no gate fault), so it says what happened. On 22 Nov BOS-2285 said "a merge card is open" for one.
      if (typeof d.note === "string" && d.note) return `Approved, but not merged: ${d.note}`;
      return "Approved, but not merged: the check couldn't finish. This isn't a problem with the agent's work; a merge card is open in Decisions, with the CEO first unless only you can fix it.";
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
export type CarriedInfo = CarriedTicket & { title: string; risk: RiskTier | null };

/** What one landing attempt ends with (landOnce). */
export type LandOnceResult = { outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted" | "carried" | "migration_journal"; delivered: string | null; detail?: unknown };


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
export const cardHeld = (cardId: string) => new ReviewHeldError(`The card ${cardId} raised on this ticket is still open, so nothing was merged. Answer it first; the merge is started again after that.`);

/** What a reviewer asks for with "Passed, hold merge" (BOS-808). */
export type HoldInput = { reason: string; waitsOn: HoldWaitInput[]; releaseAt: Date | null };

/** Who releases or cancels a hold: the holding reviewer, the CEO, or the owner (no agent). */
export type HoldActor = { name: string; agentId?: string | null; isCeo?: boolean };

/** True for the error a landing throws when the owner's sign-off card still holds the ticket. */
export function isSignoffPending(err: unknown): boolean {
  return err instanceof SignoffPendingError;
}

export type GitTemplates = { commit: string; pr: string };
export type NotifyHook = (agentId: string, input: { reason: string; note: string; ticketId?: string | null; priority?: number; causedByRunId?: string | null }) => Promise<unknown>;

/** "4 Nov 07:35 UTC", for a sign-off named on a card or event. */
export const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${formatDate("en-GB", d, { month: "short", timeZone: "UTC" })} ${iso.slice(11, 16)} UTC`;
};

/**
 * A card for a check that couldn't finish: the CEO first (alert ladder, BOS-1873), the owner after the handover or at once when
 * only they can fix it. The ticket stays in review and the loop detector never hears of it. Call it through the review
 * service's checkStuck, which also wakes the CEO.
 */
export async function raiseCheckStuck(db: Db, t: { companyId: string; id: string; title: string }, command: string, reason: string, output: string, own?: { question?: string; /** "owner" only for what the owner alone can fix: a token, the GitHub bill, a GitHub-side action (BOS-1873). */ tier?: "owner" | "ceo"; dedupeKey?: string }) {
  // A ticket closed while its check was running needs no merge card (BOS-149): read the state
  // again, because the ticket may have been merged or cancelled since this landing began.
  const [latest] = await db.select({ systemState: tickets.systemState }).from(tickets).where(eq(tickets.id, t.id));
  if (!latest || latest.systemState === "done") return;
  // BOS-1070: one card for a whole project's problem (the git token can't read CI). While one is open, others don't add theirs.
  if (own?.dedupeKey) {
    const [open] = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.status, "open"), eq(decisions.dedupeKey, own.dedupeKey))).limit(1);
    if (open) return null;
  }
  // One open merge card per ticket: this one replaces any older card (BOS-149).
  await clearMergeCards(db, t.id, { by: "system", note: `Replaced by a newer merge card: the check \`${command}\` ${reason}.`, at: new Date().toISOString() });
  const tier = own?.tier ?? "ceo";
  // BOS-1873: a CEO card carries the CEO rung of the alert ladder, or the owner's queue shows it at once.
  const ladder = tier === "ceo" ? ceoFirstLadder(t.id, CEO_FIRST_MERGE_WHY) : null;
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
      tier,
      dedupeKey: own?.dedupeKey ?? `merge-stuck:${t.id}`,
      context: { type: "check_stuck", ticketId: t.id, command, output: output.slice(-1500), ...(ladder ? { ladder } : {}) },
    })
    .onConflictDoNothing()
    .returning({ id: decisions.id, question: decisions.question });
  await lineEvent(db, t, { event: "hold_started", hold: "card", note: `the check ${reason}`.slice(0, 200) });
  return row ? { ...row, ceoFirst: !!ladder } : null;
}

/** A check's result for the merge-line timeline (BOS-769): null when it never finished, so it says nothing of the work. */
export function checkVerdict(v: VerifyResult): boolean | null {
  if (v.ok) return true;
  if ((v as { noAnswer?: boolean }).noAnswer || checkWaitedForLock(v) || checkQueueStuck(v) || checkNeverFinished(v)) return null;
  return false;
}
