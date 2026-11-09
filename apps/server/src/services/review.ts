// Review (R39): the review state carries the ticket's diff against its base, line comments
// go back to the agent as one message, and commit and PR steps are prompts from templates
// the owner can edit. Approving finishes the ticket until the merge step (R46) exists.
import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { criterionText, deepChecks, DEFAULT_GIT_TEMPLATES, formatDate, formatReviewComments, isAfterMerge, movableFailures, MERGE_MISSED_AFTER_MS, parseRepoUrl, carryFailedOver, readCriteria, readVerdicts, renderTemplate, ticketRef, RISK_TIERS, riskOf, ruleFor, slotRef, unreportedAfterMerge, type CarriedTicket, type GitHostKind, type MergeResult, type MigrationsResult, type PushResult, type ReviewComment, type ReviewSlot, type RiskTier, type VerifyResult, type WorkspaceDiff, VERIFY_ASK_TIMEOUT_MS } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, checkJobs, checkResults, companies, decisions, projects, reviewRequests, runners, settings, ticketDependencies, ticketReviews, tickets } from "../db/schema.js";
import { addTicketDependency } from "./ticket-links.js";
import type { runnersService } from "./runners.js";
import { RunnerGone } from "./runners.js";
import type { workService } from "./work.js";
import { DIFFERENT_APPROACH, type loopGuards } from "./loop-guards.js";
import { GitHostError, type GitHostConfig, type gitHostService } from "./git-hosts.js";
import { effectivePolicy, otherReviewers } from "./review-policy.js";
import { activeRows, decide, evaluate, latestRows, recordReviewWait, reviveSkipped, setReviewOrder, skipPending, wakeReviewers, type ReviewRow } from "./review-kinds.js";
import { CHECK_AGAIN, CHECK_SEND_BACK, CHECK_SKIP, clearCarriedCards, clearMergeCards, fixesLiveHeading, raiseMergeStuck, REASSIGN_REVIEW, SEND_BACK_FOR_MERGE, supersedeSignoffs, TAKE_REVIEW, WAIT_ANOTHER_HOUR, type DecisionContext } from "./decisions.js";
import { derivedSignoff, openSignoffCard, priorSignoff, raiseSignoffCard, restoreSignoffCard, signoffState, type SignoffCover } from "./signoff.js";
import { checkGate, checkPriority } from "./check-gate.js";
import { checkQueue } from "./check-queue.js";
import { LESSON_ADD, LESSON_DROP, LESSON_EDIT, LESSON_MAX, lessonsForCeo, normalizeLesson } from "./project-brief.js";
import { record } from "./activity.js";
import { lineEvent, type CheckWay, type HoldReason } from "./merge-line.js";
import { closeHold, createHold, openHold, type HoldWaitInput } from "./review-holds.js";
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
const CHECK_JOB_POLL_MS = Number(process.env.BOSSMAN_CHECK_JOB_POLL_MS) > 0 ? Number(process.env.BOSSMAN_CHECK_JOB_POLL_MS) : 3000;
const CHECK_MERGED_KEY = "check_merged_result";
/** How often a landing in progress says it is still active, so a sweep never starts a second one beside it. */
export const MERGE_ACTIVITY_MS = 60_000;
/** How long a merge waits for a runner that is away (a swap: image pull, slow start) before it counts as a failed try. */
export const RUNNER_WAIT_MS = 30 * 60_000;

/** What the author hears when a ticket that needs code changes has none. */
export const NOTHING_CHANGED = "Nothing in the repository changed. Make the change, or ask your CEO or a manager to mark the ticket as not needing code (update_ticket with noCode true) and say why.";

/** The plain-words outcome of landing, for a non-developer. */
export function landingText(r: { outcome: string; detail?: unknown }, ctx: { branch: string; assignee: string | null }): string {
  const d = (r.detail ?? {}) as { timedOut?: boolean; exitCode?: number; ms?: number; files?: string[]; problems?: string[]; url?: string | null; note?: string; carried?: Array<{ title: string }>; unchecked?: string; afterMerge?: string[] };
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
      return `Approved, but not merged: the check ${d.timedOut ? `timed out after ${Math.max(1, Math.round((d.ms ?? 0) / 60_000))} minutes` : `failed (exit code ${d.exitCode})`}. ${back} to fix; the check's output is in the conversation below.`;
    case "check_stuck":
      return "Approved, but not merged: the check couldn't finish. This isn't a problem with the agent's work; it's in your Decisions.";
    case "conflicts":
      return `Approved, but not merged: the work conflicts with ${ctx.branch} in ${(d.files ?? []).join(", ")}. ${back} to sort out.`;
    case "migration_journal":
      return `Approved, but not merged: the migration journal would make drizzle skip a migration (${(d.problems ?? []).join(" ")}). ${back} to fix.`;
    case "uncommitted":
      return `Approved, but not merged: some work isn't saved to the branch yet (${(d.files ?? []).join(", ")}). ${back} to commit it.`;
    default:
      return `Approved, but not merged (${r.outcome.replace(/_/g, " ")}).`;
  }
}

/** The highest of several risk tiers; unrated tickets are medium (BOS-130). */
export function highestRisk(risks: Array<RiskTier | null | undefined>): RiskTier {
  return risks.map(riskOf).reduce((a, b) => (RISK_TIERS.indexOf(b) > RISK_TIERS.indexOf(a) ? b : a), "trivial" as RiskTier);
}

/** A ticket whose branch carries unapproved work, and the ticket it waits for (BOS-130). */
type CarriedInfo = CarriedTicket & { title: string; risk: RiskTier | null };

/** Narrow on purpose: only the owner's "Merge without the check" uses skipChecks, for one landing. */
export type LandOptions = { skipChecks?: boolean };

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
  constructor() {
    super(409, "A reviewer passed this work but is holding the merge, so nothing was merged. Release the hold first (on the ticket page, or the reviewer or the CEO can); it merges after that.");
  }
}

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
async function raiseCheckStuck(db: Db, t: { companyId: string; id: string; title: string }, command: string, reason: string, output: string) {
  // A ticket closed while its check was running needs no merge card (BOS-149): read the state
  // again, because the ticket may have been merged or cancelled since this landing began.
  const [latest] = await db.select({ systemState: tickets.systemState }).from(tickets).where(eq(tickets.id, t.id));
  if (!latest || latest.systemState === "done") return;
  // One open merge card per ticket: this one replaces any older card (BOS-149).
  await clearMergeCards(db, t.id, { by: "system", note: `Replaced by a newer merge card: the check \`${command}\` ${reason}.`, at: new Date().toISOString() });
  const [row] = await db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "question",
      question: `"${t.title}": the merge check \`${command}\` couldn't finish (it ${reason}). This isn't a problem with the agent's work.`,
      options: [CHECK_AGAIN, CHECK_SEND_BACK, CHECK_SKIP],
      recommendedOption: CHECK_AGAIN,
      // The CEO first (BOS-446): Boss Man has already retried by itself, and the CEO can retry or send it back.
      tier: "ceo",
      dedupeKey: `merge-stuck:${t.id}`,
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
  },
) {
  let wake: NotifyHook | null = null;
  // shortcut: in memory, so a server restart mid-landing forgets the status (the ticket itself is unaffected); upgrade to a column if owners need it to survive restarts.
  const landings = new Map<string, LandingStatus>();
  // At most N merge checks at once, quick or full (BOS-446); the rest wait in order, urgent and arch fixes first.
  const gate = checkGate(db);
  const queue = checkQueue(db);
  // When each ticket's merge last said it was alive (BOS-362). The merge sweep reads this, not the ticket's
  // activity, which chat and chases also bump: talk must not hold a merge retry back, and a running merge must.
  // shortcut: in memory like `landings`; a restart ends every merge, so forgetting it is correct.
  const landingBeat = new Map<string, number>();
  // Where a running merge is: waiting its turn for a check slot, running the check, or merging (DR-014). In memory like `landings`.
  const phases = new Map<string, "queued" | "checking" | "merging" | "waiting_to_retry">();
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
   * True when a running landing's ticket has gone quiet for longer than a merge can take. The ticket's
   * last activity is the heartbeat every landing keeps, so this uses the same sign of life as the sweep.
   */
  async function landingStale(ticketId: string): Promise<boolean> {
    const [row] = await db.select({ state: tickets.systemState, lastActivityAt: tickets.lastActivityAt }).from(tickets).where(eq(tickets.id, ticketId));
    if (!row || row.state !== "review") return true;
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
    if (await openHold(db, ticketId)) return false;
    const [signoff] = await db
      .select({ id: decisions.id })
      .from(ticketDependencies)
      .innerJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
      .where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(decisions.status, "open")));
    return !signoff;
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
  async function finishMerged(t: typeof tickets.$inferSelect, commit: string | null) {
    // A criterion still at fail when the work lands was put off, not failed (BOS-575): it stays on this
    // ticket, with its assignee, as an after-merge check, instead of the ticket closing on it.
    const carry = carryFailedOver(readCriteria(t.acceptanceCriteria), t.stateNote);
    await db
      .update(tickets)
      .set({ mergeCommit: commit, pullRequestNote: null, ...(carry ? { acceptanceCriteria: carry.criteria, stateNote: carry.note, stateNoteAt: new Date() } : {}) })
      .where(eq(tickets.id, t.id));
    if (carry) t = { ...t, acceptanceCriteria: carry.criteria, stateNote: carry.note };
    await lineEvent(db, t, { event: "merged", commit });
    if (commit) await tellCeoLiveFix(t, commit).catch(() => undefined);
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

  /** After a real merge: close the ticket, or send it back to show the checks only a live host can settle. */
  async function closeAfterMerge(t: typeof tickets.$inferSelect, commit: string | null, causedByRunId?: string | null) {
    const r = await finishMerged(t, commit);
    if (!r.detail.afterMerge) return { outcome: "merged" as const, delivered: null, detail: r.detail };
    const merged = commit ? `Merged as ${commit.slice(0, 12)}. ` : "Merged. ";
    // The branch is merged, so its working copy would be released (and checking on it would need a fresh
    // clone): it's kept for this pass so the agent can show the live result where it was.
    const [repoUrl] = await db
      .select({ repoUrl: projects.repoUrl })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, t.id));
    if (repoUrl?.repoUrl) await deps.work.updateTicket(t.id, { state: "in_progress", overLimit: true, internal: true, noCode: true });
    const carried = r.detail.carried ?? [];
    const quoted = (list: string[]) => list.map((c) => `"${c}"`).join(", ");
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

  /** True while the owner's "Merge it, or send it back?" sign-off card for this ticket is open (BOS-471). */
  async function ownerSignoffOpen(ticketId: string): Promise<boolean> {
    return !!(await openSignoffCard(db, ticketId));
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
        const [signoff] = await db
          .select({ id: decisions.id })
          .from(ticketDependencies)
          .innerJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
          .where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(decisions.status, "open")));
        if (signoff || (await derivedSignoff(db, t)).state === "waiting") throw new ReviewError(409, "Every review is in; the ticket is waiting on the owner's decision before it merges.");
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
        await decide(db, row.id, { status: "approved", notes: input.summary?.trim() || null });
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
      // Where the review policy says the owner signs off, an agent's approval asks them (R48).
      if (o.reviewerAgentId && ruleFor(await effectivePolicy(db, t), t.risk).ownerSignoff) {
        // One open sign-off card per ticket: this round replaces any older one (BOS-446).
        // The owner signs off a commit, not a ticket (DR-013). A runner that can't say the head never reuses a sign-off.
        const head = await this.diff(ticketId).then((x) => x.head || null, () => null);
        const prior = await priorSignoff(db, t, head);
        // A standing sign-off on an earlier commit also counts when only clean main merges came in since (BOS-734).
        if (!prior.reuse && head && prior.current && prior.current.head !== head && (await this.signoffCovers(ticketId, prior.current.head, head))?.covers) {
          prior.reuse = prior.current;
          await record(db, { companyId: t.companyId, agentId: o.reviewerAgentId, ticketId, kind: "signoff_carried", summary: `The owner's sign-off on ${prior.current.head.slice(0, 8)} still covers ${head.slice(0, 8)}: since then main was only merged in automatically, with no clashes and no new code from the ticket.` });
        }
        if (prior.reuse) {
          await record(db, { companyId: t.companyId, agentId: o.reviewerAgentId, ticketId, kind: "signoff_reused", summary: `The owner's sign-off from ${when(prior.reuse.at)} was reused: ${o.reviewer} approved the same commit ${head!.slice(0, 8)}, so it merges without asking again.` });
          if (o.background) return { verdict: "approved" as const, outcome: "landing" as const, delivered: null, landing: await this.startLanding(ticketId, o.reviewer, o.causedByRunId) };
          return { verdict: "approved" as const, ...(await this.landVisible(ticketId, o.reviewer, o.causedByRunId)) };
        }
        const id = await raiseSignoffCard(db, t, { reviewer: o.reviewer, reviewerAgentId: o.reviewerAgentId, head, earlier: prior.earlier });
        await lineEvent(db, t, { event: "hold_started", hold: "sign_off", decisionId: id ?? null });
        return { verdict: "approved" as const, outcome: "owner_review" as const, delivered: `the owner reviews ${riskOf(t.risk)}-risk work; decision ${id}` };
      }
      if (o.background) return { verdict: "approved" as const, outcome: "landing" as const, delivered: null, landing: await this.startLanding(ticketId, o.reviewer, o.causedByRunId) };
      return { verdict: "approved" as const, ...(await this.landVisible(ticketId, o.reviewer, o.causedByRunId)) };
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

    /**
     * One line for `tickets read` (DR-024 #2): the host's checks on the head of the ticket's branch.
     * Null when there's nothing to say (no branch, already merged, no known host or token). A host
     * that refuses the token is said plainly, never shown as "no checks".
     */
    async branchChecksLine(ticketId: string, companyId?: string): Promise<string | null> {
      try {
        const { t, repoUrl, gitHost, gitApiBase } = await ticketWithRepo(ticketId, companyId);
        if (!t.branch || t.mergeCommit || t.systemState === "done" || !deps.gitHosts) return null;
        const a = repoUrl ? parseRepoUrl(repoUrl) : null;
        const token = await deps.gitToken?.(t.companyId);
        if (!a || (gitHost !== "github" && gitHost !== "gitea") || !gitApiBase || !token) return null;
        const cfg = { kind: gitHost as GitHostKind, apiBase: gitApiBase, owner: a.owner, repo: a.repo };
        const sha = await deps.gitHosts.branchHead(cfg, token, t.branch);
        const c = await deps.gitHosts.checks(cfg, token, sha);
        const at = sha.slice(0, 8);
        const names = c.failing.join(", ");
        if (c.state === "none") return `CI on branch head ${at}: no checks reported (yet).`;
        if (c.state === "failed") return `CI on branch head ${at}: FAILED${names ? ` (${names})` : ""}.`;
        if (c.state === "pending") return `CI on branch head ${at}: still running.`;
        return `CI on branch head ${at}: passed${c.total ? ` (${c.total} check${c.total === 1 ? "" : "s"})` : ""}.`;
      } catch (err) {
        if (err instanceof GitHostError) {
          const hint = err.status === 401 || err.status === 403 || err.status === 404
            ? " The company's git token may lack read access to checks: on GitHub a fine-grained token needs Repository permissions → Checks: Read-only."
            : "";
          return `CI on branch head: not available (${err.message}).${hint}`;
        }
        return null;
      }
    },

    /** Every merge this process has running, with its phase, for the merge queue screen (BOS-587). */
    runningMerges(): Array<{ ticketId: string; startedAt: string; startedBy: string; phase?: "queued" | "checking" | "merging" | "waiting_to_retry" }> {
      return [...landings.entries()].flatMap(([ticketId, l]) =>
        l.state === "running" ? [{ ticketId, startedAt: l.startedAt, startedBy: l.startedBy, phase: phases.get(ticketId) ?? ("checking" as const) }] : [],
      );
    },

    /** True while a merge for this ticket has said it is alive within the merge window (a check or lock wait under way). */
    landingActive(ticketId: string): boolean {
      return Date.now() - (landingBeat.get(ticketId) ?? 0) <= MERGE_MISSED_AFTER_MS;
    },

    /**
     * The files this ticket's branch would clash with on the default branch, or null when that can't be
     * told (no repo, no connected runner, an older runner, or a failed check). Null means "carry on as
     * if it merges": a check that can't answer never holds a reviewer back (BOS-426).
     */
    async branchClash(ticketId: string): Promise<string[] | null> {
      try {
        const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
        if (!repoUrl || !t.branch) return null;
        const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
        if (!runner || !deps.runners.isConnected(runner.id) || !deps.runners.can(runner.id, "clash-check")) return null;
        const r = await deps.runners.request<{ clashes?: boolean; files?: string[] }>(runner.id, (requestId) => ({ type: "workspace.clash", requestId, projectId: t.projectId, ticketId: t.id, target: defaultBranch }), 15_000);
        if (typeof r?.clashes !== "boolean") return null;
        return r.clashes ? (r.files ?? []) : [];
      } catch {
        return null;
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
      await this.claimLanding(ticketId, reviewer);
      try {
        return await this.land(ticketId, reviewer, causedByRunId, opts);
      } finally {
        // The ticket page reloads when a running marker goes away; a finished banner comes from startLanding.
        if (landings.get(ticketId)?.state === "running") landings.delete(ticketId);
      }
    },

    /** Runs land() without holding the request (the check can take minutes); the outcome is kept for the page to poll. */
    async startLanding(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<LandingStatus> {
      // Nothing can merge while the owner's sign-off card is open (BOS-471): refuse before claiming the
      // landing, so a press cannot leave a retry marker or a retry card behind for a ticket that is simply
      // waiting on one answer.
      if (await ownerSignoffOpen(ticketId)) throw new SignoffPendingError();
      // Nor while a reviewer holds the merge (BOS-808): a normal wait, no marker and no card.
      if (await openHold(db, ticketId)) throw new ReviewHeldError();
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
          text = `Approved, but not merged: ${(err as Error).message}`;
        }
        landings.set(ticketId, { state: "finished", outcome, text, url, finishedAt: new Date().toISOString() });
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
    async land(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<{ outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted" | "carried" | "migration_journal"; delivered: string | null; detail?: unknown }> {
      const [lineRow] = await db.select({ id: tickets.id, companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ticketId));
      if (lineRow) await lineEvent(db, lineRow, { event: "attempt", by: reviewer.slice(0, 200) });
      try {
        // A merge check that only waited too long for the shared lock is queued again, with a longer pause each time.
        // The ticket stays in review; the pause counts as activity so the unmerged-approvals sweep leaves it alone.
        let goneTries = 0;
        for (let attempt = 1; ; attempt++) {
          let r: Awaited<ReturnType<typeof this.landOnce>> | { outcome: "runner_gone"; delivered: null; detail: { message: string } };
          try {
            r = await this.landOnce(ticketId, reviewer, causedByRunId, opts);
          } catch (err) {
            if (!(err instanceof RunnerGone)) throw err;
            r = { outcome: "runner_gone", delivered: null, detail: { message: err.message } };
          }
          if (r.outcome === "runner_gone") {
            // The runner restarted or went away under the merge (DR-014): the work is fine. Try again by itself, keeping the place in line.
            const { t } = await ticketWithRepo(ticketId);
            const message = (r.detail as { message: string }).message;
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
            if (now?.state !== "review") return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while the merge waited, so it was not retried." } };
            if (deps.isLeader && !deps.isLeader()) return { outcome: "check_stuck", delivered: null, detail: { note: "Handed over while the merge waited; the server now in charge restarts it." } };
            attempt--;
            continue;
          }
          if (r.outcome === "merged") void this.retryHeldBy(ticketId).catch(() => undefined);
          if (r.outcome !== "lock_wait") return r;
          const { t } = await ticketWithRepo(ticketId);
          const d = r.detail as { command: string; output: string };
          if (attempt >= LOCK_RETRY_ATTEMPTS) {
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `Merge check gave up waiting for the lock after ${attempt} tries; it's in your Decisions.` });
            await raiseCheckStuck(db, t, d.command, "kept waiting for the shared lock, which other checks held", d.output);
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
          if (now?.state !== "review") return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while the merge check waited, so it was not retried." } };
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
    async requireSignoff(t: typeof tickets.$inferSelect, head: string | null) {
      const d = await derivedSignoff(db, t, head || null);
      if (d.state === "not_needed") return;
      if (d.state === "signed_off" && (head === null || d.head === null || d.head === head)) {
        if (head === "" && d.head !== null) throw new ReviewError(409, "The owner's sign-off couldn't be matched to the commit: the runner didn't say which commit would merge, so nothing was merged. Try again once the runner answers.");
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
        await restoreSignoffCard(db, t, "a merge was about to start without it", head || null);
        throw new SignoffPendingError();
      }
      if (d.state === "reviews_pending") throw new ReviewError(409, "This ticket needs the owner's sign-off and its reviews aren't all in, so it wasn't merged.");
      // Signed off, but for another commit: the code changed after the owner approved it.
      throw new ReviewError(409, `The owner signed off commit ${d.head!.slice(0, 8)}, but ${head!.slice(0, 8)} would merge, so nothing was merged. It needs a new review and sign-off.`);
    },

    async landOnce(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<{ outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted" | "carried" | "migration_journal"; delivered: string | null; detail?: unknown }> {
      const { t, repoUrl, defaultBranch, verifyCommand, deepVerifyCommand, landing, gitHost, gitApiBase } = await ticketWithRepo(ticketId);
      // An answer to an older "merge stuck" ask can arrive after the ticket merged: nothing to do again.
      if (t.systemState === "done") return { outcome: "done", delivered: null, detail: { note: "It was already finished, so nothing ran again." } };
      // A retry must not merge past the owner's sign-off (BOS-149): if a "Merge it, or send it back?"
      // card is still open, this ticket waits for the owner, whatever answered the merge card.
      if (await ownerSignoffOpen(ticketId)) throw new SignoffPendingError();
      // Nor past a reviewer's hold (BOS-808); every merge path comes through here, so this fails them all closed.
      if (await openHold(db, ticketId)) throw new ReviewHeldError();
      // Nor past a sign-off that isn't recorded (BOS-503, DR-021): a lost card used to let the unmerged-approvals
      // retry and carried-work landing merge a high-risk ticket the owner never saw. Every path into a merge comes
      // through here, so this one check fails them all closed. A card that went missing is raised again.
      await this.requireSignoff(t, null);
      // A merge under way is activity: the unmerged-approvals sweep waits for it rather than asking again.
      const touch = () => beatNow(ticketId);
      await touch();
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
          throw new ReviewError(409, (err as Error).message);
        }
      };
      const sendBack = async (text: string, reason: string) => {
        await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
        return tellAgent({ ...t, systemState: "in_progress" }, text, reason, causedByRunId);
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
      let changed = await whileActive(() => ask<WorkspaceDiff>((requestId) => ({ type: "workspace.diff", requestId, projectId: t.projectId, ticketId, baseRef: defaultBranch }), 60_000)).catch(() => null);
      // A ticket sent back after its merge as no-code, then reopened for real work (BOS-532): a commit on its
      // branch now is that work. Clear the stale no-code mark and read the diff again (a diff read over the
      // old commit may show nothing), so the review checks code and the branch merges like any other.
      let noCode = t.noCode;
      if (noCode && changed?.commits.length) {
        await db.update(tickets).set({ noCode: false }).where(eq(tickets.id, ticketId));
        await record(db, { companyId: t.companyId, ticketId, kind: "reopened", summary: "Reopened for code: its branch has new commits again, so it is no longer a no-code ticket." });
        noCode = false;
        changed = await whileActive(() => ask<WorkspaceDiff>((requestId) => ({ type: "workspace.diff", requestId, projectId: t.projectId, ticketId, baseRef: defaultBranch }), 60_000)).catch(() => null);
      }
      // The owner signs off a commit (DR-013): the one about to merge must be it. No head read means no merge.
      // A ticket with no branch has nothing to merge, so only the early check above applies to it.
      await this.requireSignoff(t, changed ? changed.head : t.branch ? "" : null);
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
      const named = (command: string) => (command === project && verifyCommand ? verifyCommand : command);
      const checks = opts?.skipChecks ? [] : [project, needsDeep ? deepVerifyCommand : null].filter((c): c is string => !!c);
      const kindOf = (command: string) => (named(command) === deepVerifyCommand && named(command) !== verifyCommand ? "deep_verify" : "verify");
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
        // The same failing check again and again means the agent is going round in circles (R50).
        const loop = await deps.loops.failure({ companyId: t.companyId, ticketId, agentId: t.assigneeAgentId, text: v.timedOut ? `timeout: ${command}` : v.output, what: "The check" });
        const delivered = await sendBack(`The review was approved, but the check \`${command}\` ${why}, so the ticket can't be merged yet. Fix it, then move the ticket back to review.\n\nLast output:\n${v.output.slice(-4000)}${loop.circular ? DIFFERENT_APPROACH(loop.count) : ""}`, "verify failed");
        return { outcome: "verify_failed", delivered, detail: v };
      };
      // BOS-313 (F6): with the setting on, the checks run on the merge commit that will be pushed, inside the merge itself.
      // BOS-316 (DR-003): in server mode the merged result is checked by a job in the check queue, not inside the merge request.
      const serverChecks = landing !== "pull_request" && checks.length > 0 && (await queue.mode()) === "server";
      const checkMerged = !serverChecks && landing !== "pull_request" && checks.length > 0 && (await checkMergedResult());
      for (const command of checkMerged || serverChecks ? [] : checks) {
        await touch();
        // Through the gate: at most N checks run at once. A runner that doesn't answer counts as an infra failure too.
        const runCheck = (alone: boolean) =>
          whileActive(() => {
            phases.set(ticketId, "queued");
            return timedCheck(named(command), "gate", (w) => gate.run(checkPriority(t), alone, w), checkVerdict, () => {
              phases.set(ticketId, "checking");
              return ask<VerifyResult>((requestId) => ({ type: "workspace.verify", requestId, projectId: t.projectId, ticketId, command }), VERIFY_ASK_TIMEOUT_MS).catch((err: Error): VerifyResult & { noAnswer: true } => {
                // The runner went away mid-check: land() runs the merge again once it is back, without using the check retries.
                if (err instanceof RunnerGone) throw err;
                return { ok: false, exitCode: null, timedOut: false, output: err.message, ms: 0, noAnswer: true };
              });
            });
          });
        let v = await runCheck(false);
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
        }
        await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: t.pullRequestHead, kind: kindOf(command), passed: v.ok, detail: v.ok ? null : v.output.slice(-500) });
        if (!v.ok) return checkFailed(named(command), v);
      }

      // Its migrations must not take a number another branch already has (BOS-219): the merge is the
      // moment it matters, so this is checked again here and, when taken, the ticket goes back with
      // the number free right now. A check that can't say never blocks the merge.
      const migrations = await this.migrations(ticketId, undefined, false).catch(() => null);
      if (migrations?.needed) {
        const delivered = await sendBack(
          `The review was approved, but a migration number is already taken: ${migrations.why.join("; ")}. Another branch merged a migration with the same number, so this can't land as it is. Rename it to ${String(migrations.next).padStart(4, "0")} (and any others it moved), set its journal entry's \`when\` later than the newest one already on ${defaultBranch}, run \`node scripts/lint-migrations.mjs\` (which now catches this), run the checks${verifyCommand ? ` (\`${verifyCommand}\`)` : ""}, commit, then move the ticket back to review.${migrations.others.length ? `\nOther numbers taken: ${migrations.others.join("; ")}.` : ""}`,
          "migration number taken",
        );
        return { outcome: "verify_failed", delivered, detail: migrations };
      }

      // A pull request: the host must be known and reachable before anything is pushed (R59).
      const pr = landing === "pull_request" ? await prTarget(t.companyId, repoUrl, gitHost, gitApiBase) : null;
      // The runner does one git job per repo at a time, so a merge can queue behind other agents' fetches and
      // worktree set-ups before its own fetch and push; two minutes wasn't enough on a busy project. A merge
      // that finishes after this is still safe: trying again finds the branch already merged.
      await touch();
      phases.set(ticketId, "merging");
      type Stuck = { status: "job_stuck"; command: string; reason: string; output: string };
      // Server mode: build the merge commit, queue a merge job for its tree, wait on the job's row, then push exactly what was checked.
      const serverMerge = async (): Promise<MergeResult | Stuck> => {
        const message = `Merge "${t.title}" (${ticketId})`;
        for (let round = 0; round < 3; round++) {
          const prep = await ask<MergeResult>((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message, phase: "prepare" }), MERGE_WAIT_MS);
          if (prep.status !== "prepared") return prep;
                    for (const command of checks) {
            const { job, reused } = await queue.enqueue({ companyId: t.companyId, projectId: t.projectId, ticketId, kind: "merge", scope: "full", commit: prep.commit, tree: prep.tree, command, priority: checkPriority(t) });
            // The merge-line record (BOS-769) takes the job's own start and end times; the poll only notices them.
            const line = { check: named(command), way: "queue" as const, jobId: job.id };
            await lineEvent(db, t, { event: "check_queued", ...line, ...(reused ? { reused: true } : {}) });
            let seenStart = 0;
            const started = async (j: typeof job) => {
              if (j.startedAt && j.startedAt.getTime() !== seenStart) {
                seenStart = j.startedAt.getTime();
                await lineEvent(db, t, { event: "check_started", ...line }, j.startedAt);
              }
            };
            // An earlier pass of the same tree is reused as it is: it ran before this attempt, so only queued and ended are written, now.
            if (reused !== "passed") await started(job);
            let cur = job;
            while (cur.state === "queued" || cur.state === "running") {
              await new Promise((resolve) => setTimeout(resolve, CHECK_JOB_POLL_MS));
              const [row] = await db.select().from(checkJobs).where(eq(checkJobs.id, cur.id));
              if (!row) {
                await lineEvent(db, t, { event: "check_ended", ...line, passed: null, why: "the check job disappeared from the queue" });
                return { status: "job_stuck", command, reason: "The check job disappeared from the queue.", output: "" };
              }
              cur = row;
              await started(cur);
            }
            await lineEvent(db, t, { event: "check_ended", ...line, passed: cur.state === "passed" ? true : cur.state === "failed" ? checkVerdict({ ok: false, exitCode: cur.exitCode, timedOut: /timed out/i.test(cur.reason ?? ""), output: cur.logTail ?? "", ms: 0 }) : null, ...(cur.reason && cur.state !== "passed" ? { why: cur.reason.slice(0, 200) } : {}) }, reused === "passed" ? new Date() : (cur.endedAt ?? new Date()));
            if (cur.state === "passed") await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: prep.commit, kind: kindOf(command), passed: true, detail: null });
            if (cur.state === "stuck" || cur.state === "cancelled") return { status: "job_stuck", command, reason: cur.reason ?? `The check job was ${cur.state}.`, output: cur.logTail ?? "" };
            if (cur.state === "failed") return { status: "check_failed", command, result: { ok: false, exitCode: cur.exitCode, timedOut: /timed out/i.test(cur.reason ?? ""), output: cur.logTail ?? "", ms: cur.startedAt && cur.endedAt ? cur.endedAt.getTime() - cur.startedAt.getTime() : 0 } };
          }
          await touch();
          const fin = await ask<MergeResult>((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message, phase: "finish", commit: prep.commit, tree: prep.tree }), MERGE_WAIT_MS);
          if (fin.status !== "main_moved") return fin;
        }
        return { status: "main_moved" };
      };
      const m0: MergeResult | PushResult | Stuck = serverChecks
        ? await whileActive(serverMerge)
        : pr
        ? await whileActive(() => ask<PushResult>((requestId) => ({ type: "workspace.push", requestId, projectId: t.projectId, ticketId, target: defaultBranch }), MERGE_WAIT_MS))
        : await whileActive(() =>
            (checkMerged
              ? (w: () => Promise<MergeResult>) =>
                  timedCheck(checks.map(named).join(" && "), "merged", (x) => gate.run(checkPriority(t), false, x), (r) => (r.status === "merged" ? true : r.status === "check_failed" ? checkVerdict(r.result) : null), w)
              : (w: () => Promise<MergeResult>) => w())(() => ask<MergeResult>(
              (requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: `Merge "${t.title}" (${ticketId})`, ...(checkMerged ? { checks } : {}) }),
              // The runner may check up to three merged results, one after another.
              checkMerged ? MERGE_WAIT_MS + 3 * checks.length * VERIFY_ASK_TIMEOUT_MS : MERGE_WAIT_MS,
            )),
          );
      if (m0.status === "job_stuck") {
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The queued merge check stopped before it finished: ${m0.reason}` });
        await raiseCheckStuck(db, t, named(m0.command), `stopped: ${m0.reason}`, m0.output);
        return { outcome: "check_stuck", delivered: null, detail: m0 };
      }
      const m: MergeResult | PushResult = m0;
      if (m.status === "prepared") throw new ReviewError(409, "The runner answered the merge with an unfinished step; try again.");
      if (m.status === "check_failed") {
        await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: t.pullRequestHead, kind: kindOf(m.command), passed: false, detail: m.result.output.slice(-500) });
        return checkFailed(named(m.command), m.result);
      }
      // The target kept moving while the merged result was checked; nothing was pushed, so land() tries again.
      if (m.status === "main_moved") return { outcome: "lock_wait", delivered: null, detail: m };
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
          `The review was approved, but your branch conflicts with ${defaultBranch} in: ${m.files.join(", ")}. Merge origin/${defaultBranch} into your branch, resolve the conflicts keeping both sides' intent, run the checks${verifyCommand ? ` (\`${verifyCommand}\`)` : ""}, commit, then move the ticket back to review.`,
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
      // BOS-690 (DR-037): the gate renumbered a clashing migration itself. One line, no wake, no card: nothing for anyone to do.
      if (m.status === "merged" && m.renamed?.length) {
        const names = m.renamed.map((r) => `${r.from} landed as ${r.to}`).join("; ");
        await record(db, { companyId: t.companyId, ticketId, kind: "migration_renamed", summary: `Migration ${names}; the SQL is unchanged, renamed by the merge gate because another ticket took the number first.` });
      }
      // BOS-316: what was pushed is exactly the tree a merge job just passed, so main passes its check (P11a).
      if (serverChecks && m.status === "merged") await queue.setMainState(t.projectId, "green", m.commit);
      // Its own after-merge checks keep this ticket open (DR-024 #5), but not the ones riding along.
      const mine = await closeAfterMerge(t, m.commit, causedByRunId);
      for (const c of together) {
        await db.update(tickets).set({ mergeCommit: m.commit }).where(eq(tickets.id, c.ticketId));
        // A fix riding along on this merge is just as live (BOS-639).
        const [rider] = await db.select().from(tickets).where(eq(tickets.id, c.ticketId));
        if (rider) await tellCeoLiveFix(rider, m.commit).catch(() => undefined);
        if (rider) await lineEvent(db, rider, { event: "merged", commit: m.commit });
        await deps.work.updateTicket(c.ticketId, { state: "done", outcome: "completed", overLimit: true });
      }
      return { ...mine, delivered: mine.delivered, detail: mine.detail };
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
