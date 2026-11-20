// The merge rounds of one merge attempt (BOS-1903, move 3 of the BOS-1886 split): regions J and K of landOnce (the server
// merge and its check rounds, the legacy and CI-gated merges, the plain merge and the merge train), moved out of
// merge-attempt.ts unchanged. landOnce calls it once, after its CI step (merge-ci-step.ts), with the service as `this`,
// the shared context as `ctx`, the attempt's setup values as `a` and the CI step's closures as `c`. It returns what the
// merge came to (`m1`) and the pull-request target, which landOnce's outcome reads; a merge-train re-run that passed
// sets `a.flakyCheck`.
import { and, eq, inArray, ne } from "drizzle-orm";
import { gateMergeMessage } from "./missed-merges.js";
import { type MergeResult, type PushResult, VERIFY_ASK_TIMEOUT_MS } from "@boss-man/shared";
import { checkJobs, checkResults, checkWorkers, projects, tickets } from "../db/schema.js";
import { RunnerGone } from "./runners.js";
import type { CiStop } from "./ci-publish.js";
import { clearMergeCards } from "./decisions.js";
import { SUPERSEDED_TEXT } from "./check-queue.js";
import { record } from "./activity.js";
import { lineEvent, TRAIN_CLASH_FILES } from "./merge-line.js";
import { mainGen, trainFor, type RestackWhy, type TrainClash } from "./merge-train.js";
import { landingTurns } from "./landing-turn.js";
import { mergeHolds } from "./review-holds.js";
import { CHECK_JOB_POLL_MS, checkNeverFinished, checkVerdict, MAX_CI_REFRESHES, MERGE_RETARGET_MS, MERGE_WAIT_MS, TRAIN_TRIAL_FALLBACK_MS, TRAIN_TRIAL_MIN_MS, WAIT_RECHECK_MS } from "./review-common.js";
import type { ReviewCtx } from "./review-ctx.js";
import type { ReviewSelf } from "./review.js";
import type { MergeAttempt } from "./merge-attempt.js";
import type { CiStepParts, Early } from "./merge-ci-step.js";

export async function mergeRounds(this: ReviewSelf, ctx: ReviewCtx, a: MergeAttempt, c: CiStepParts) {
  const { db, deps, gate, queue, phases, clashOnMain, namedTickets, prTarget, mergeCarry, mergeRetarget, mergeTurnMinutes, holdForWaits, refuseIfHeld } = ctx;
  const { t, ticketId, opts, runner, repoUrl, defaultBranch, landing, gitHost, gitApiBase, touch, inReview, leftReview, whileActive, askMerge, checks, combinedCommand, named, kindOf, timedCheck, checkPrio, serverChecks, checkMerged, ci } = a;
  const { publishAndWait, ciVerdict, alongsideCi, legacyChecks } = c;
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
  // "refreshed" (BOS-1820): with CI gating, the queued job took a new merge (`prep`) the old one's pass couldn't be carried onto.
  type RoundEnd = { status: "passed" } | { status: "stopped" } | { status: "branch_moved"; head: string; pinned: string } | { status: "restack"; why: RestackWhy } | Stuck | { status: "job_superseded" } | { status: "left_review" } | { status: "handed_over" } | CheckFailed | { status: "refreshed"; prep: Prepared };
  const message = gateMergeMessage(t.title, ticketId);
  const retargetSwitch = mergeRetarget;
  // Never while CI gating is on (BOS-1070): CI was published for this commit, and a retargeted tree is one CI never ran on.
  // With CI, ciRefreshOn below (BOS-1820) refreshes only a merge whose pass couldn't be carried, and restarts its CI run.
  const retargetOn = async () => !ci && (await retargetSwitch());
  // BOS-1365: one job per merge. Two jobs on one tree each waited for a slot and a quick merge landed in between. When the
  // deep check differs from the project check, one job runs both (project check first, with FULL_CHECK_NEXT so it skips what
  // the deep check repeats). The deep check is "also", never instead. skipChecks leaves `checks` empty, so nothing is queued.
  const queuedChecks = combinedCommand && checks.length > 1 ? [combinedCommand] : [...new Set(checks)];
  // base / expectBase only reach a runner that announced "merge-base" (the train checks that before it runs).
  // carryFrom (BOS-1820) only reaches a runner that announced "merge-refresh" (ciRefreshOn checks that).
  const prepare = (base?: string, carryFrom?: { commit: string; tree: string }) => askMerge((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message, phase: "prepare", ...(base ? { base } : {}), ...(carryFrom ? { carryFrom } : {}) }), MERGE_WAIT_MS);
  const finish = (prep: Prepared, expectBase?: string, carry?: boolean) => askMerge((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message, phase: "finish", commit: prep.commit, tree: prep.tree, ...(expectBase ? { expectBase } : {}), ...(carry ? { carry: true } : {}) }), MERGE_WAIT_MS);
  // BOS-1762: carry only to a runner that announced "merge-carry" (an older one's zod would drop it), and only while the
  // owner's switch is on. Read once per attempt.
  const carryOn = deps.runners.can(runner.id, "merge-carry") && (await mergeCarry());
  /**
   * BOS-1820: with GitHub CI gating, a queued merge is refreshed only when main moved in a way its pass couldn't be carried
   * across (finish would refuse it and rebuild after both the check and GitHub had run). A file-disjoint move is left alone:
   * the carry lands it with no second GitHub run. Needs the carry itself, a runner that answers prepare's carryFrom, and
   * the owner's merge_retarget switch (Settings → Checks, "Rebuild waiting merges when main moves"), which turns both refreshes off.
   */
  const ciRefreshOn = async () => !!ci && carryOn && deps.runners.can(runner.id, "merge-refresh") && (await retargetSwitch());
  const turnCapMs = (await mergeTurnMinutes()) * 60_000;
  const inReviewNow = async (id: string) => (await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, id)))[0]?.state === "review";
  /**
   * BOS-1762: the push after both checks passed. Waits while another ticket holds the project's landing turn (its checks
   * and GitHub run are done; only the push waits), then finishes, carrying across a file-disjoint main move when allowed.
   * A carry that lost a push race is tried again on the newer tip without preparing (three times at most). A main move it
   * can't carry counts as a rebuild, and the second one takes the landing turn.
   */
  const landPassed = async (prep: Prepared, fin0?: () => Promise<MergeResult | null>): Promise<MergeResult | { status: "left_review" } | { status: "handed_over" } | null> => {
    let waiting = false;
    // BOS-1821: while it waits for another ticket's turn, the merge asks the runner (BOS-1820's carry question) whether its
    // pass could still be carried onto today's main: at the start of the wait, whenever the gate pushes to main, and every
    // WAIT_RECHECK_MS for pushes from elsewhere. A refusal is the rebuild finish would have ordered when the turn ended, so
    // it happens now; a conflict goes back to the author now. Same gate as BOS-1820 (carry, runner, merge_retarget switch).
    let waitCheck: boolean | undefined;
    let askedEpoch = -1;
    let askedAt = 0;
    let early: Extract<MergeResult, { status: "main_moved" }> | null = null;
    for (;;) {
      const c = landingTurns.check(t.projectId);
      if (c.expired) await lineEvent(db, { id: c.expired.ticketId, companyId: t.companyId }, { event: "landing_turn", action: "expired", capMin: Math.round(c.expired.capMs / 60_000) });
      if (!c.holder || c.holder.ticketId === ticketId) break;
      if (!(await inReviewNow(c.holder.ticketId))) {
        // The holder was sent back or moved by hand while its merge waited: its turn ends here.
        if (landingTurns.done(t.projectId, c.holder.ticketId)) await lineEvent(db, { id: c.holder.ticketId, companyId: t.companyId }, { event: "landing_turn", action: "ended" });
        continue;
      }
      if (!waiting) {
        waiting = true;
        const [h] = await db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, c.holder.ticketId));
        await lineEvent(db, t, { event: "hold_started", hold: "turn", note: `"${h?.title ?? c.holder.ticketId}" has the landing turn; this merge pushes when it lands or the turn ends` });
      }
      // BOS-1769: also an out-and-back move since this attempt began, like every other wait in the landing.
      if (await leftReview()) return { status: "left_review" };
      // BOS-1752: a copy that handed over while it waited for the turn must not push; the server now in charge restarts it.
      if (deps.isLeader && !deps.isLeader()) return { status: "handed_over" };
      waitCheck ??= carryOn && deps.runners.can(runner.id, "merge-refresh") && (await retargetSwitch());
      const epoch = landingTurns.mainEpoch(t.projectId);
      if (waitCheck && (epoch !== askedEpoch || Date.now() - askedAt >= WAIT_RECHECK_MS)) {
        askedEpoch = epoch;
        askedAt = Date.now();
        // Any trouble but a lost runner: keep waiting, and finish decides when the turn ends, as before.
        const fresh = await prepare(undefined, { commit: prep.commit, tree: prep.tree }).catch((err: Error) => {
          if (err instanceof RunnerGone) throw err;
          return null;
        });
        if (fresh?.status === "conflicts" || fresh?.status === "migration_journal" || fresh?.status === "branch_moved") return fresh;
        if (fresh?.status === "prepared" && fresh.tree !== prep.tree && fresh.carry?.ok === false) {
          early = { status: "main_moved", notCarried: { why: fresh.carry.why, ...(fresh.carry.files ? { files: fresh.carry.files } : {}) } };
          break;
        }
      }
      await touch();
      await new Promise((resolve) => setTimeout(resolve, CHECK_JOB_POLL_MS));
    }
    if (early) {
      const files = early.notCarried?.files;
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `Main changed ${files?.length ? files.slice(0, 3).join(", ") + (files.length > 3 ? ", …" : "") : "shared files"} while this merge waited for another ticket's landing turn, so it is rebuilt and checked again now rather than when that turn ends. Nothing to do.` });
    }
    let fin = early ?? (fin0 ? await fin0() : await finish(prep, undefined, carryOn));
    for (let race = 0; fin?.status === "main_moved" && fin.carryEligible && race < 3; race++) fin = await finish(prep, undefined, carryOn);
    if (fin?.status === "merged" && fin.carried) await lineEvent(db, t, { event: "carried_across", ...fin.carried });
    if (fin?.status === "main_moved") {
      const r = landingTurns.rebuilt(t.projectId, ticketId, turnCapMs);
      await lineEvent(db, t, { event: "rebuilt", rebuilds: r.count, ...(fin.notCarried ? { why: fin.notCarried.why, ...(fin.notCarried.files ? { files: fin.notCarried.files } : {}) } : {}) });
      if (r.turn) await lineEvent(db, t, { event: "landing_turn", action: r.turn, rebuilds: r.count, capMin: Math.round(turnCapMs / 60_000) });
    }
    return fin;
  };
  /** BOS-1762: a merge that ended any way but main_moved gives up its count and its landing turn. */
  const turnOver = async <R extends { status: string }>(r: R): Promise<R> => {
    if (r.status !== "main_moved" && landingTurns.done(t.projectId, ticketId)) await lineEvent(db, t, { event: "landing_turn", action: "ended" });
    return r;
  };
  /**
   * One round: the merge's check job(s) on one prepared tree (BOS-316), waited on through their rows. `ref.prep` is that tree;
   * the BOS-1344 refresh may move it while the round's first job is still queued. `stale` (merge train, BOS-1366) is asked on
   * every poll: once it names a reason the round ends and the caller prepares again. Queueing the new tree then replaces a
   * queued job and keeps its place (BOS-1328); a running one is cancelled as a leftover, which frees its slot.
   */
  const runRound = async (ref: { prep: Prepared }, o: { refresh: () => Promise<boolean>; ciRefresh?: () => Promise<boolean>; stale?: () => RestackWhy | null; onRetarget?: (p: Prepared) => void; train?: () => { place: number; ahead: number } | undefined; stop?: CiStop; leftReview?: () => Promise<boolean> }): Promise<RoundEnd> => {
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
          // BOS-1752: a copy that handed over (blue/green deploy) stops here. The server now in charge waits on this same job
          // (it adopts or reuses it), so this copy writes no line rows: before this, its second check_started and its early
          // check_ended (when the new leader's CI push superseded this copy's run) looked like a check nobody waited on.
          if (deps.isLeader && !deps.isLeader()) return { status: "handed_over" };
          // GitHub CI failed meanwhile (BOS-1070): the job runs on (a pass is reused next time), but this attempt is over.
          if (o.stop?.stopped) {
            await lineEvent(db, t, { event: "check_ended", ...line, passed: null, why: "GitHub CI failed first; the job carries on and a pass is reused" });
            return { status: "stopped" };
          }
          await new Promise((resolve) => setTimeout(resolve, CHECK_JOB_POLL_MS));
          // Handed over during the pause: stop before the left-review cancel, restack or retarget below act on the leader's job.
          if (deps.isLeader && !deps.isLeader()) return { status: "handed_over" };
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
          // BOS-1833: a hold set after the attempt began (a merge-check fix hold, a card, a waits-on link) still applies to a
          // check that has not started. refuseIfHeld ran only at the attempt's start, so a check waiting for a slot, or queued
          // again after main moved, used to start under a hold (18 Nov: BOS-1774, BOS-1669, BOS-1670). A running check is left
          // alone: stopping it wastes work and the hold still stops the merge before it lands.
          if (cur.state === "queued" && (await mergeHolds(db, ticketId)).length > 0) {
            await deps.cancelCheck?.(cur.id, "The merge is held, so its queued check was stopped.").catch(() => undefined);
            await lineEvent(db, t, { event: "check_ended", ...line, passed: null, why: "the merge was held while the check waited" });
            await refuseIfHeld(ticketId);
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
          const refreshDue = command === queuedChecks[0] && cur.state === "queued" && Date.now() - lastRefresh >= MERGE_RETARGET_MS;
          // BOS-1820: GitHub CI gates this merge. Ask whether the queued merge's pass could still be carried onto a fresh one;
          // only a refusal retargets the job (keeping its place) and ends the round, so the caller restarts GitHub on the new
          // commit. Carry ok or the same tree: nothing changes, the running GitHub run stands and finish carries.
          if (refreshDue && o.ciRefresh && (await o.ciRefresh())) {
            lastRefresh = Date.now();
            const fresh = await prepare(undefined, { commit: prep.commit, tree: prep.tree }).catch(() => null);
            if (fresh?.status === "branch_moved") return fresh;
            if (fresh?.status === "prepared" && fresh.tree !== cur.tree && fresh.carry?.ok === false) {
              const moved = await queue.retarget(cur.id, { commit: fresh.commit, tree: fresh.tree });
              // null: a runner claimed the job meanwhile, so it runs on the old tree and finish decides, as before.
              if (moved) {
                ref.prep = fresh;
                await lineEvent(db, t, { event: "check_ended", ...line, passed: null, why: "main changed files a pass couldn't be carried across; the job takes the new merge, keeping its place" });
                return { status: "refreshed", prep: fresh };
              }
            }
          } else if (refreshDue && (await o.refresh())) {
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
        // BOS-1752: the job ended while this copy handed over (between two polls): the server in charge records and lands it.
        if (deps.isLeader && !deps.isLeader()) return { status: "handed_over" };
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
  /**
   * BOS-1805: main moved, so the next round builds a new merge and queues a new 30-50 min check. A merge-check fix that
   * merged (or was marked) after this attempt began holds every other merge until it is live (mergeWaits), but the hold
   * was only read when an attempt started or failed, so an attempt already in flight kept rebuilding and re-queuing
   * checks past it (18 Nov, after BOS-1762 merged). Read it again before each rebuild: held, the attempt ends as
   * "Passed, held" (ReviewHeldError), with nothing queued.
   */
  const heldBeforeRebuild = async (round: number) => {
    if (round === 0) return;
    const waiting = await holdForWaits(ticketId);
    if (waiting) throw waiting;
  };
  type ServerMergeEnd = MergeResult | Stuck | { status: "job_superseded" } | { status: "left_review" } | { status: "handed_over" };
  // Server mode: build the merge commit, queue a merge job for its tree, wait on the job's row (and GitHub CI beside it when
  // on, BOS-1070), then push exactly what was checked.
  const serverMerge = async (): Promise<ServerMergeEnd | Early> => {
    // BOS-1371: the first round of an adopted merge uses the live job's commit and tree; any trouble falls back to a normal prepare.
    // The train doesn't adopt: it re-prepares, and the same tree reuses the live job through enqueue. Nor does CI gating: an
    // adopted commit was never published, so CI would start from scratch on it anyway, and a normal prepare does that.
    let adopted = ci ? undefined : opts?.adopt;
    // BOS-1820: the merge a refreshed round moved its queued job to. The next round starts on it without preparing again and
    // isn't counted: nothing was checked or landed, so it is no rebuild and earns no landing turn.
    let refreshed: Prepared | undefined;
    let refreshes = 0;
    // BOS-1762: a ticket that took the landing turn gets one more round, so the turn it earned isn't wasted on the round cap.
    for (let round = 0; round < 3 || (round < 4 && landingTurns.holds(t.projectId, ticketId)); round++) {
      if (!refreshed) await heldBeforeRebuild(round);
      const prep: MergeResult = refreshed ?? (adopted ? { status: "prepared", commit: adopted.commit, tree: adopted.tree, targetSha: "" } : await prepare());
      refreshed = undefined;
      if (prep.status !== "prepared") return prep;
      const wasAdopted = !!adopted;
      adopted = undefined;
      const ref = { prep };
      const r = await alongsideCi(prep, async (stop) => {
        const end = await runRound(ref, { refresh: retargetOn, ...(refreshes < MAX_CI_REFRESHES ? { ciRefresh: ciRefreshOn } : {}), stop, leftReview });
        return end.status === "passed" || end.status === "stopped" ? null : end;
      });
      if (r?.status === "refreshed") {
        refreshes++;
        const why = r.prep.carry?.ok === false ? r.prep.carry : { why: "main changed", files: undefined };
        await lineEvent(db, t, { event: "refreshed", why: why.why, ...(why.files?.length ? { files: why.files } : {}), refreshes });
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `Main changed ${why.files?.length ? why.files.slice(0, 3).join(", ") + (why.files.length > 3 ? ", …" : "") : "shared files"} while the merge check waited for a slot, so the merge was rebuilt on the current main before its check started (it keeps its place, and GitHub CI starts again on the new merge). Nothing to do.` });
        refreshed = r.prep;
        round--;
        continue;
      }
      if (r?.status === "restack") continue; // only the train restacks; kept for the type
      if (r) return r;
      // BOS-1769: the check (and CI) passed, but the ticket left review meanwhile: a pass that is over never pushes. A landing
      // started for its next pass reuses the passed job on the same tree.
      if (await leftReview()) return { status: "left_review" };
      await touch();
      phases.set(ticketId, "merging");
      // The runner may have lost the adopted commit (it restarted too): prepare again rather than fail. A runner that went away stays an error.
      const fin = await landPassed(ref.prep, wasAdopted ? () => finish(ref.prep, undefined, carryOn).catch((err: Error) => { if (err instanceof RunnerGone) throw err; return null; }) : undefined);
      if (fin && fin.status !== "main_moved") return fin;
    }
    return { status: "main_moved" };
  };
  // Legacy mode with CI gating (BOS-1070): the same split merge, with the branch's own checks beside the CI wait. Legacy
  // checks test the branch, not the merge, so a rebuilt merge (main moved) doesn't run them again.
  const legacyCiMerge = async (): Promise<MergeResult | Early | { status: "left_review" } | { status: "handed_over" }> => {
    for (let round = 0; round < 3 || (round < 4 && landingTurns.holds(t.projectId, ticketId)); round++) {
      await heldBeforeRebuild(round);
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
      const fin = (await landPassed(prep))!;
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
    // BOS-1803: the background-lane age is re-read on every landing (the owner's save also sets it at once).
    const { train, created } = trainFor(t.projectId, deps.checkCapacity ? await deps.checkCapacity(t.companyId) : await queue.slots(), (await queue.laneAge()) * 60_000);
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
            return serverMerge().then(turnOver);
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
            return serverMerge().then(turnOver);
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
            if (r.status === "passed") a.flakyCheck = failedCheck;
            if (r.status === "passed") await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The merge check \`${failedCheck}\` failed, then passed when run again on the same tree: a flaky failure. It is counted in the merge-line record. Nothing to do.` });
          }
          if (r.status === "restack") {
            if (!(await restack(r.why))) return { status: "main_moved" };
            continue;
          }
          // The train never runs with CI gating, so nothing stops its rounds; never read "stopped" as a pass.
          if (r.status === "stopped") throw new Error("A merge-train check round was stopped by a CI wait that the train doesn't run.");
          // Nor a CI-gated refresh (BOS-1820): the train passes no ciRefresh.
          if (r.status === "refreshed") throw new Error("A merge-train check round was refreshed for a CI wait that the train doesn't run.");
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
    ? await whileActive(trainMode ? trainMerge : () => serverMerge().then(turnOver))
    : pr
    ? await whileActive(() => askMerge<PushResult>((requestId) => ({ type: "workspace.push", requestId, projectId: t.projectId, ticketId, target: defaultBranch }), MERGE_WAIT_MS))
    : ci && checkMerged
    ? await whileActive(ciThenChecked)
    : ci
    ? await whileActive(() => legacyCiMerge().then(turnOver))
    : await plainOrChecked();
  return { m1, pr };
}
