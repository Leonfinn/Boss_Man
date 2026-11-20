// The review service's landing start and retry loop (BOS-1904, move 4 of the BOS-1886 split): the CEO's merge retry,
// claiming and starting a landing, land() (which runs landOnce again after a lock wait, a runner restart or a git
// blip), and the merges started again after one lands. Each is a review service method moved out whole: it takes the
// service as `this` (so calls to other methods go through the assembled object, where tests spy on them) and the shared
// context as `ctx`. review.ts keeps one delegate line per method.
import { and, eq, ne, sql } from "drizzle-orm";
import { deepChecks, type WorkspaceDiff } from "@boss-man/shared";
import { agents, runners, tickets } from "../db/schema.js";
import { RunnerGone } from "./runners.js";
import { GIT_RETRY_CARD_NOTE, GIT_RETRY_NOTE, isGitTransportFault } from "./git-transport-fault.js";
import { evaluate, latestRows } from "./review-kinds.js";
import { CHECK_AGAIN, clearCarriedCards, clearMergeCards, raiseMergeStuck } from "./decisions.js";
import { record } from "./activity.js";
import { leftLineSince, lineEvent, type FailReason } from "./merge-line.js";
import { recordFailedAttempt } from "./merge-failures.js";
import { mainMoved } from "./merge-train.js";
import { openHold, releaseReadyHolds } from "./review-holds.js";
import { carriedTitles } from "./merge-queue.js";
import { INFRA_RETRY_ATTEMPTS, INFRA_RETRY_BASE_MS, isSignoffPending, landingText, LOCK_RETRY_ATTEMPTS, LOCK_RETRY_BASE_MS, LOCK_RETRY_TEXT, MERGE_ACTIVITY_MS, ReviewError, ReviewHeldError, SETTLE_FREE_TRIES, type LandingStatus, type LandOptions } from "./review-common.js";
import type { ReviewCtx } from "./review-ctx.js";
import type { ReviewSelf } from "./review.js";

/**
 * The CEO starts a fresh merge attempt on an approved ticket the gate refused (BOS-684), the same retry the sweep
 * makes once per server: the whole gate runs again on the connected runner. Only an approved ticket still in review;
 * it never skips the checks (that stays the owner's), and an open sign-off card still holds it (startLanding).
 */
export async function retryMerge(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, input: { byAgentId: string; companyId: string; causedByRunId?: string | null }) {
  const { db, landings, ticketWithRepo, landingStale, ownerSignoffOpen } = ctx;
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
}

/** Claims the ticket's merge marker, so the page shows the merge from its first moment. */
export async function claimLanding(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, reviewer: string): Promise<string> {
  const { landings, phases, beatNow, landingStale } = ctx;
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
}

/**
 * Lands and waits, as land() does (a sign-off card's answer still finishes the merge before it returns),
 * but keeps the running marker for as long as it takes so every page shows the merge in flight.
 */
export async function landVisible(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions) {
  const { landings } = ctx;
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
}

/** BOS-1645: after every merge attempt, look at main for a merge that was pushed but not recorded (this one's included). */
export async function afterLandingSweep(this: ReviewSelf, ctx: ReviewCtx, ticketId: string) {
  const { db } = ctx;
  const [t] = await db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId)).catch(() => []);
  if (t) await this.recordMissedMerges(t.projectId).catch(() => undefined);
}

/** Runs land() without holding the request (the check can take minutes); the outcome is kept for the page to poll. */
export async function startLanding(this: ReviewSelf, rctx: ReviewCtx, ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<LandingStatus> {
  // The shared context is `rctx` here, not `ctx`: the body's own `ctx` (the ticket and its repo) keeps the name it had in review.ts.
  const { db, landings, ticketWithRepo, mergeStuck, refuseIfHeld } = rctx;
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
}

/**
 * What approval does (R46, R47). Without a repo the ticket is simply done. With one, the
 * project's check runs in the worktree, then the branch is merged into the project's
 * default branch, and the merge closes the ticket. A failed check, a conflict or
 * uncommitted work sends the ticket back to the agent with what to do.
 */
export async function land(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<{ outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted" | "carried" | "migration_journal" | "branch_changed"; delivered: string | null; detail?: unknown }> {
  const { db, deps, phases, beatNow, ticketWithRepo, tellCeo, mergeStuck, checkStuck, setGitNote } = ctx;
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
    let settleTries = 0;
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
        // BOS-2089: a runner that has only just come back is still catching up (its repo lock, the work the restart
        // queued), so a try that fails then is spent waiting, not used up: the card comes only once the runner has
        // been back RUNNER_SETTLE_MS and the merge still fails. SETTLE_FREE_TRIES caps it for a runner that keeps reconnecting.
        const [rn] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
        if (rn && deps.runners.isSettling(rn.id) && settleTries < SETTLE_FREE_TRIES) settleTries++;
        else goneTries++;
        if (goneTries > INFRA_RETRY_ATTEMPTS) {
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The runner kept going away under the merge (${message}); the merge card is with the CEO first.` });
          await checkStuck(t, "the merge", "was cut off because the runner restarted or went away", message);
          return { outcome: "check_stuck", delivered: null, detail: r.detail };
        }
        const pause = INFRA_RETRY_BASE_MS * 2 ** Math.min(goneTries + settleTries - 1, 2);
        const tryText = goneTries === 0 ? "the runner has only just come back, so this try isn't counted" : `try ${goneTries} of ${INFRA_RETRY_ATTEMPTS}`;
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `Runner restarted: the merge was cut off (${message}); running it again (${tryText}, in ${Math.max(1, Math.round(pause / 1000))}s). Nothing to do.` });
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
}

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
export async function releaseHolds(this: ReviewSelf, ctx: ReviewCtx, ticketId?: string): Promise<string[]> {
  const { db, deps } = ctx;
  if (deps.isLeader && !deps.isLeader()) return [];
  return releaseReadyHolds(db, (id) => this.startLanding(id, "Boss Man (what this merge waited on is merged and live)"), ticketId);
}

/**
 * BOS-1647: the push to the default branch landed but the merge was never recorded (the runner or server was cut off
 * between the two, or the ticket left review before a retry). When the ticket's approved head is already inside the
 * default branch, records the merge with the commit that brought it in, exactly as a merge that finished would: no new
 * merge attempt, no push, no bounce. Null when the ticket isn't in that state (head not on main, not approved on this
 * head, uncommitted work, already done), so the caller carries on as before. `known` is a diff the caller just read.
 */
export async function recordLanded(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, causedByRunId?: string | null, known?: WorkspaceDiff | null): Promise<{ outcome: "merged"; delivered: string | null; detail?: unknown } | null> {
  const { db, ticketWithRepo, closeAfterMerge } = ctx;
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
}

export async function retryHeldBy(this: ReviewSelf, ctx: ReviewCtx, mergedId: string): Promise<string[]> {
  const { db, deps, approvedAndWaiting } = ctx;
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
}
