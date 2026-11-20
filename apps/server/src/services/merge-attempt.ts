// One merge attempt of the review service (BOS-1902, move 2 of the BOS-1886 split): landOnce and mergePullRequest, moved
// out of review.ts whole. Each takes the service as `this` (so calls to other methods go through the assembled object,
// where tests spy on them) and the shared context as `ctx`. review.ts keeps one delegate line per method.
import { and, eq, gt, inArray, ne } from "drizzle-orm";
import { gateMergeMessage } from "./missed-merges.js";
import { ownerApprovedFiles } from "@boss-man/shared";
import { checkFailureFacts, fullLogPointer, deepChecks, renderTemplate, ticketRef, RISK_TIERS, riskOf, type MergeResult, type PushResult, type VerifyResult, type WorkspaceDiff, VERIFY_ASK_TIMEOUT_MS } from "@boss-man/shared";
import { agents, checkJobs, checkResults, checkWorkers, companies, projects, runners, ticketMessages, tickets } from "../db/schema.js";
import { RunnerGone } from "./runners.js";
import { DIFFERENT_APPROACH } from "./loop-guards.js";
import { CiPublishError, ciStops, publishAndWait as ciPublishAndWait, type CiOutcome, type CiStop, type FlakeAnswer } from "./ci-publish.js";
import { CANT_RERUN_EXIT, FLAKE_RETRY_KIND, flakeDecision, gateRerunCommand, namedTestFiles, RETRIES_PER_WEEK, RETRY_WINDOW_MS, retryCounts } from "./ci-flake.js";
import { GitHostError, type CiStatus, type GitHostConfig } from "./git-hosts.js";
import { latestRows } from "./review-kinds.js";
import { CHECK_AGAIN, clearMergeCards, supersedeSignoffs } from "./decisions.js";
import { ticketCheckPriority } from "./check-gate.js";
import { SUPERSEDED_TEXT } from "./check-queue.js";
import { record } from "./activity.js";
import { leftLineSince, lineEvent, TRAIN_CLASH_FILES, type CheckWay } from "./merge-line.js";
import { tellCeoLineHolderSentBack } from "./line-holder.js";
import { mainGen, trainFor, type RestackWhy, type TrainClash } from "./merge-train.js";
import { landingTurns } from "./landing-turn.js";
import { mergeHolds, touchesScope } from "./review-holds.js";
import { knownRedOnly, mainCiFailures, namedFiles, type BranchFailure, type OpenFailure } from "./main-ci.js";
import { CHECK_JOB_POLL_MS, checkNeverFinished, checkQueueStuck, checkVerdict, checkWaitedForLock, ciBounceRecord, FLAKE_RERUN_MAX_MS, FULL_CHECK_NEXT, gateBounceRecord, HANDED_OVER_WHY, INFRA_CAUSE_TEXT, INFRA_RETRY_ATTEMPTS, INFRA_RETRY_BASE_MS, MAX_CI_REFRESHES, MERGE_ACTIVITY_MS, MERGE_RETARGET_MS, MERGE_WAIT_MS, NOTHING_CHANGED, ReviewError, RUNNER_WAIT_MS, TRAIN_TRIAL_FALLBACK_MS, TRAIN_TRIAL_MIN_MS, WAIT_RECHECK_MS, type CarriedInfo, type InfraCause, type LandOnceResult, type LandOptions } from "./review-common.js";
import type { ReviewCtx } from "./review-ctx.js";
import type { ReviewSelf } from "./review.js";

export async function landOnce(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions, begun: Date = new Date()): Promise<{ outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted" | "carried" | "migration_journal" | "branch_changed"; delivered: string | null; detail?: unknown }> {
  const { db, deps, state: reviewState, gate, queue, scanListWarning, phases, ciWaits, ciPassedTrees, ciCardWaiting, ciTiming, beatNow, ticketWithRepo, clashOnMain, namedTickets, prTarget, carriedBetween, approvedAndWaiting, refuseUnchecked, refuseCarried, announceMerged, afterMergeLeft, closeAfterMerge, tellCeoLiveFix, pagePriorityMerge, tellCeo, checkStuck, wait, tellAgent, checkMergedResult, waitForCi, mergeCarry, mergeRetarget, mergeTurnMinutes, templates, holdForWaits, refuseIfHeld } = ctx;
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
  // `what`: one line for the CEO when this ticket holds the merge line (R32); defaults to the reason.
  const sendBack = async (text: string, reason: string, what?: string) => {
    await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
    const delivered = await tellAgent({ ...t, systemState: "in_progress" }, text, reason, causedByRunId);
    await tellCeoLineHolderSentBack(db, reviewState.wake, t, what ?? reason);
    return delivered;
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
        await checkStuck(t, "carried-work check", "the runner didn't answer the check for other tickets' unmerged work", err.message);
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
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `The check queue made no progress for ${mins} minutes (the same check held the slot); the merge check gave up and the merge card is with the CEO first.` });
      await checkStuck(t, command, `was stopped: the check queue made no progress for ${mins} minutes, because the check holding the slot never finished`, v.output);
      return { outcome: "check_stuck", delivered: null, detail: v };
    }
    const never: InfraCause | null = (v as { noAnswer?: boolean }).noAnswer ? "no_answer" : checkNeverFinished(v);
    if (never) {
      const reason = INFRA_CAUSE_TEXT[never](v.ms);
      await checkStuck(t, command, reason, v.output);
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
    const delivered = await sendBack(`The review was approved, but the check \`${command}\` ${why}, so the ticket can't be merged yet. Fix it, then move the ticket back to review. If the failure isn't caused by your branch (the same step fails on main, or the check itself is broken), don't change your code: tell the CEO, who marks the ticket fixing the check (update_ticket fixesMergeCheck), then move this ticket back to review on the same commit; its approvals and sign-off are kept and it waits, held, for that fix.${facts ? `\n\nWhat failed: ${facts}.` : ""}\n\nLast output:\n${v.output.slice(-4000)}${v.keptLog ? `\n\n${fullLogPointer(v.keptLog.jobId, v.keptLog.ticketId, v.keptLog.chars)}` : ""}${loop.circular ? DIFFERENT_APPROACH(loop.count) : ""}`, "verify failed", `the gate's check \`${command}\` ${why}${facts ? ` (${facts})` : ""}`);
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
  const publishAndWait = (prep: { commit: string; tree: string; targetSha: string }, stop: CiStop): Promise<CiOutcome> => {
    // BOS-1871: the wait's start and end in the merge-line records, so a CI wait can be told from a stall afterwards.
    // The start row is written once, on the first wait report; the end row (awaited after it) says how the wait ended.
    let ciWaitFrom: number | null = null;
    let ciWaitStartRow: Promise<void> = Promise.resolve();
    const endCiWait = async (outcome: string) => {
      if (ciWaitFrom === null) return;
      const waitedMs = Math.max(0, Date.now() - ciWaitFrom);
      ciWaitFrom = null;
      await ciWaitStartRow;
      await lineEvent(db, t, { event: "ci_wait_ended", commit: prep.commit, outcome, waitedMs });
    };
    return ciPublishAndWait(
      {
        hosts: deps.gitHosts!,
        target: ci!,
        timing: ciTiming,
        passedTrees: ciPassedTrees,
        // BOS-1664: the runner scans before this push with the owner's list too (a runner without "ci-publish-scan" drops the field).
        publish: async (commit) => {
          const scanList = await scanListWarning.forScan();
          ciPushed = true;
          return ask<MergeResult>((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: "publish for CI", phase: "publish", commit, ...(scanList ? { scanList } : {}) }), MERGE_WAIT_MS);
        },
        announce: async (branch) => {
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `Pushed the merge commit ${prep.commit.slice(0, 12)} to ${branch} for GitHub CI; Boss Man's own check runs at the same time. Nothing to do.` });
        },
        announceRerun: async (commit) => {
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub cancelled the CI run for ${commit.slice(0, 12)} and no newer run replaced it, so Boss Man asked GitHub to run it once more. Nothing to do.` });
        },
        onWait: (s) => {
          if (s && ciWaitFrom === null) {
            ciWaitFrom = s.since;
            ciWaitStartRow = lineEvent(db, t, { event: "ci_wait_started", commit: prep.commit }, new Date(s.since));
          }
          if (s) ciWaits.set(ticketId, s);
          else ciWaits.delete(ticketId);
        },
        touch,
        // BOS-1733: only in server check-queue mode, where the gate can queue a job on the exact merge commit.
        ...(serverChecks && deps.cancelCheck ? { flakeRetry: (s: CiStatus, st: CiStop) => flakeRetry(prep, s, st), announceFlakeRetry: (files: string[], accepted: boolean) => announceFlakeRetry(prep, files, accepted) } : {}),
      },
      prep,
      stop,
    ).then(
      async (got) => {
        // R40: a failure that is only main's known red becomes known_red, which lets the gate's own check finish.
        const red = got.kind === "failed" && !got.status.billing ? await knownRed(got.status) : null;
        const o: CiOutcome = red ? { kind: "known_red", ...red } : got;
        await endCiWait(o.kind);
        // BOS-1749: the branch has done its job on every ending except a pass (the merge deletes it after landing) and a
        // replacement by a newer push (that push owns the branch now). Best effort; the periodic sweep catches a miss.
        if (o.kind !== "passed" && o.kind !== "superseded") await dropCiBranch();
        return o;
      },
      async (err: Error) => {
        await endCiWait("error");
        await dropCiBranch();
        throw err instanceof CiPublishError ? new ReviewError(409, err.message) : err;
      },
    );
  };
  let ciPushed = false; // a refusal before the push leaves nothing to delete
  const dropCiBranch = () => !ciPushed ? Promise.resolve() : ask<MergeResult>((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: "unpublish", phase: "unpublish" }), MERGE_WAIT_MS).then(() => undefined, () => undefined);
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
    // BOS-1873: the token and the bill are the owner's; a read that kept failing (a GitHub outage) the CEO retries first.
    const raised = await checkStuck(t, "GitHub CI", why === "access" ? "couldn't read GitHub Actions runs" : why === "billing" ? "wasn't started by GitHub (billing)" : "couldn't be read from GitHub", message, { question, tier: why === "error" ? "ceo" : "owner", dedupeKey: `ci-${why}:${t.projectId}` });
    if (raised === null) {
      const held = ciCardWaiting.get(t.projectId) ?? new Set<string>();
      held.add(ticketId);
      ciCardWaiting.set(t.projectId, held);
    }
    await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `Not merged: ${why === "access" ? "the git token can't read GitHub Actions runs" : why === "billing" ? "GitHub didn't start CI (billing)" : "GitHub's CI result couldn't be read"} (${message.slice(0, 200)}). ${raised === null ? "It waits on the card already open for this project and starts again when it's answered." : why === "error" ? "The card is with the CEO first." : "It's in the owner's Decisions."}` });
    return { outcome: "check_stuck", delivered: null, detail: { ci: why, message } };
  };
  // BOS-1733 (CI fix 2): GitHub failed in named tests this branch doesn't change. The decision table (ci-flake.ts) says
  // whether to try; then the gate runs those tests once more on the exact merge commit, as a merge-kind job on the same
  // commit and tree (so every reader of the ticket's merge jobs treats it as part of this merge: restart pick-up, the
  // branch-moved cancel, its place in line). Failing there means the failure is real; passing buys one GitHub retry.
  /**
   * R40 (BOS-1685): the failure is main's known GitHub-only red, not this branch's. All of: the gate's own check of
   * main isn't red (so the red is GitHub-only); the red's ticket is open and its scope known; this branch's files don't
   * touch that scope (nor .github/ or a root file); and every failed job matches the red exactly (knownRedOnly). The
   * last condition, the gate's own check passing, holds because a known_red outcome doesn't stop that check (ciStops).
   * Any doubt (a read fails, a diff unknown) is null: the usual path.
   */
  const knownRed = async (s: CiStatus): Promise<{ jobs: string[]; refs: string[] } | null> => {
    try {
      const [proj] = await db.select({ s: projects.mainState }).from(projects).where(eq(projects.id, t.projectId));
      if (!proj || proj.s === "red") return null;
      const open = await mainCiFailures(db, t.projectId);
      if (!open.length || !s.failed.length) return null;
      const mine = changed?.files.length ? changed.files.map((f) => f.path) : null;
      if (!mine) return null;
      const reds: Array<OpenFailure & { ref: string }> = [];
      for (const r of open) {
        if (!r.scope?.length || touchesScope(mine, r.scope)) continue;
        const [rt] = await db.select({ state: tickets.systemState, number: tickets.number, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, r.ticketId));
        if (!rt || rt.state === "done") continue;
        reds.push({ ...r, ref: ticketRef(rt.prefix, rt.number) ?? r.ticketId });
      }
      if (!reds.length) return null;
      const found = await deps.gitHosts!.failures(ci!.cfg, ci!.token, s.failed).catch(() => []);
      const failed: BranchFailure[] = [];
      for (const run of s.failed) {
        const f = found.find((x) => x.run === run);
        const log = run.id ? await deps.gitHosts!.jobLogBlock(ci!.cfg, ci!.token, run.id).catch(() => [] as string[]) : [];
        const files = new Set([...(f?.paths ?? []).filter(Boolean), ...namedFiles([...(f?.lines ?? []), ...log])]);
        failed.push({ job: run.name, ...(run.step ? { step: run.step } : {}), files: [...files] });
      }
      const m = knownRedOnly(failed, reds);
      return m ? { jobs: s.failed.map((r) => r.name), refs: [...new Set(m.map((r) => (r as OpenFailure & { ref: string }).ref))] } : null;
    } catch {
      return null;
    }
  };
  // not state: one landing attempt's flake counts, dropped when it returns.
  let flakeCounts = new Map<string, number>();
  const flakeRetry = async (prep: { commit: string; tree: string }, s: CiStatus, stop: CiStop): Promise<FlakeAnswer> => {
    // BOS-1752: a copy that handed over queues no re-run and asks GitHub for no retry; ciVerdict then ends it quietly.
    if (deps.isLeader && !deps.isLeader()) return { retry: false, why: HANDED_OVER_WHY };
    // R40: main's known red would pass a re-run at the gate (GitHub-only) and fail GitHub's retry: neither is worth it.
    if (await knownRed(s)) return { retry: false, why: "it fails the same way on main" };
    const found = await deps.gitHosts!.failures(ci!.cfg, ci!.token, s.failed).catch(() => []);
    const named = namedTestFiles(s.failed.map((run) => ({ job: run.name, paths: found.find((f) => f.run === run)?.paths ?? null })));
    const diff = await readDiff().catch(() => null);
    const [proj] = await db.select({ s: projects.mainState }).from(projects).where(eq(projects.id, t.projectId));
    const since = new Date(Date.now() - RETRY_WINDOW_MS);
    const rows = await db.select({ sha: checkResults.sha, detail: checkResults.detail }).from(checkResults).where(and(eq(checkResults.companyId, t.companyId), eq(checkResults.kind, FLAKE_RETRY_KIND), gt(checkResults.at, since)));
    flakeCounts = retryCounts(rows.map((r) => r.detail));
    const d = flakeDecision({
      billing: !!s.billing || found.some((f) => f.billing),
      named,
      changed: diff ? diff.files.map((f) => f.path) : null,
      mainRed: proj?.s === "red",
      retriedThisCommit: rows.some((r) => r.sha === prep.commit),
      recent: flakeCounts,
    });
    if (d.act === "bounce") return { retry: false, why: d.why };
    const files = d.files;
    await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub CI failed in ${files.join(", ")}, which this branch doesn't change. Boss Man is running ${files.length > 1 ? "them" : "it"} once more on the same merge commit (${prep.commit.slice(0, 12)}) before deciding. Nothing to do.` });
    const { job } = await queue.enqueue({ companyId: t.companyId, projectId: t.projectId, ticketId, kind: "merge", scope: "quick", commit: prep.commit, tree: prep.tree, command: gateRerunCommand(files), priority: checkPrio, requestedBy: null });
    const deadline = Date.now() + FLAKE_RERUN_MAX_MS;
    let cur = job;
    while (cur.state === "queued" || cur.state === "running") {
      // BOS-1752: handed over: leave the re-run job alone (the server now in charge reuses it for the same commit and tree).
      if (deps.isLeader && !deps.isLeader()) return { retry: false, why: HANDED_OVER_WHY };
      // The gate's own check failed meanwhile: its send-back is the answer, and the re-run's slot is given back.
      if (stop.stopped || Date.now() > deadline) {
        await deps.cancelCheck?.(cur.id, stop.stopped ? "Boss Man's own merge check failed first, so the re-run of GitHub's failed tests was stopped." : "The re-run of GitHub's failed tests took too long, so it was stopped.").catch(() => undefined);
        return { retry: false, why: stop.stopped ? "Boss Man's own merge check failed first" : `the re-run at Boss Man's gate didn't finish within ${Math.round(FLAKE_RERUN_MAX_MS / 60_000)} minutes` };
      }
      await touch();
      await new Promise((resolve) => setTimeout(resolve, CHECK_JOB_POLL_MS));
      const [row] = await db.select().from(checkJobs).where(eq(checkJobs.id, cur.id));
      if (!row) return { retry: false, why: "the re-run at Boss Man's gate disappeared from the check queue" };
      cur = row;
    }
    if (cur.state === "passed") return { retry: true, files };
    const tail = cur.logTail ?? "";
    if (cur.state === "failed" && cur.exitCode !== CANT_RERUN_EXIT && !/timed out/i.test(cur.reason ?? "")) {
      return { retry: false, why: `${files.join(", ")} failed again when Boss Man re-ran ${files.length > 1 ? "them" : "it"} on the same merge commit, so the failure is real`, gateOutput: tail.slice(-3000) };
    }
    const said = [...tail.matchAll(/^boss-man re-run: (.+)$/gm)].pop()?.[1];
    return { retry: false, why: `Boss Man couldn't re-run ${files.length > 1 ? "them" : "it"} at its gate (${(cur.state === "failed" && cur.exitCode === CANT_RERUN_EXIT && said ? said : cur.reason ?? cur.state).slice(0, 200)})` };
  };
  // The one retry is recorded only once GitHub accepted it: the record is what the per-commit and per-week limits count.
  const announceFlakeRetry = async (prep: { commit: string }, files: string[], accepted: boolean) => {
    if (!accepted) {
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `${files.join(", ")} passed when Boss Man re-ran ${files.length > 1 ? "them" : "it"}, but GitHub refused to re-run the failed jobs (the git token needs Actions: Read and write), so the ticket goes back as before.` });
      return;
    }
    await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: prep.commit, kind: FLAKE_RETRY_KIND, passed: true, detail: files.join("\n") });
    const counts = files.map((f) => `${f}: retry ${(flakeCounts.get(f) ?? 0) + 1} of ${RETRIES_PER_WEEK} this week`).join("; ");
    await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `${files.join(", ")} passed when Boss Man re-ran ${files.length > 1 ? "them" : "it"} on the same merge commit, so Boss Man asked GitHub to re-run the failed jobs once (${counts}). Nothing to do.` });
  };
  // After a retried run passed: one "Flaky on GitHub: <file>" ticket per file for the CEO, reused while it is open.
  const reportFlaky = async (files: string[], url: string | undefined, commit: string) => {
    const [co] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
    const ref = ticketRef(co?.prefix ?? null, t.number) ?? `"${t.title}"`;
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
    for (const file of files) {
      const n = (flakeCounts.get(file) ?? 0) + 1;
      const line = `GitHub CI failed in \`${file}\` on the merge of ${ref} ("${t.title}", commit ${commit.slice(0, 12)}${url ? `, ${url}` : ""}). It passed when Boss Man re-ran it on the same commit, and again on GitHub's one retry, so ${ref} merged. Retry ${n} of ${RETRIES_PER_WEEK} this week for this file; after ${RETRIES_PER_WEEK}, a failure in it sends the ticket back until it is fixed.`;
      const title = `Flaky on GitHub: ${file}`.slice(0, 200);
      const [open] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.companyId, t.companyId), eq(tickets.title, title), ne(tickets.systemState, "done"))).limit(1);
      if (open) {
        await db.insert(ticketMessages).values({ companyId: t.companyId, ticketId: open.id, author: "system", text: line });
        continue;
      }
      const made = await deps.work.createTicket(t.projectId, {
        title,
        body: [`**Why:** ${line}`, "", `**Do:** find why \`${file}\` fails on GitHub's runners and not at Boss Man's gate, and fix the test (CLAUDE.md: "Writing tests: they must pass on GitHub's runners too"). Each further one-off failure is added here.`, "", "Opened by Boss Man's merge gate after a recorded GitHub retry (BOS-1733)."].join("\n"),
        risk: "medium",
        state: "ready",
        overLimit: true,
        assigneeAgentId: ceo?.id ?? null,
        createdByAgentId: null,
      });
      await tellCeo(made, "flaky test on GitHub", `${line} Boss Man opened "${made.title}" for it. Assign it to whoever should fix the test.`).catch(() => undefined);
    }
  };
  // What a CI wait means for this attempt: null carries on to the merge, anything else ends it.
  const ciVerdict = async (o: CiOutcome, prep: { commit: string; tree: string }): Promise<LandOnceResult | null> => {
    // BOS-1752: a copy that handed over acts on no CI result: the server now in charge published its own merge commit and
    // reads CI on that. Before this, a standby sent tickets back, raised cards or retried on a run the new leader replaced.
    if (deps.isLeader && !deps.isLeader()) return { outcome: "check_stuck", delivered: null, detail: { note: "Handed over while GitHub CI ran; the server now in charge carries on with the merge." } };
    switch (o.kind) {
      case "stopped":
        return null;
      case "passed":
        if (!o.reused) {
          ciPassedTrees.add(prep.tree);
          if (ciPassedTrees.size > 500) ciPassedTrees.delete(ciPassedTrees.values().next().value!);
          await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: prep.commit, kind: "ci", passed: true, detail: null });
        }
        if (o.flaky?.length) {
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub CI passed on its one retry, so ${o.flaky.join(", ")} failed only once; Boss Man told the CEO about the flaky test. Nothing to do.` });
          await reportFlaky(o.flaky, o.retryRunUrl, prep.commit).catch(() => undefined);
        }
        startCiWaiters();
        return null;
      case "known_red":
        // R40: no "ci" pass row on purpose: this tree never passed GitHub CI, so no later run may reuse it as green.
        // The gate's own check still decides: alongsideCi waits for it (known_red isn't in ciStops), ciThenChecked runs it next.
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub CI failed only in ${o.jobs.join(", ")}, which also fails on main (${o.refs.join(", ")}) and which this branch doesn't touch, so it merges on Boss Man's own check. Nothing to do.` });
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
        await checkStuck(t, "GitHub CI", `was still running after ${mins} minutes${o.waiting.length ? ` (${o.waiting.join(", ")})` : ""}`, "");
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `Not merged: GitHub CI was still running after ${mins} minutes; the merge card is with the CEO first.` });
        return { outcome: "check_stuck", delivered: null, detail: { ci: "timeout", waiting: o.waiting } };
      }
      case "superseded":
        // A newer push to the CI branch replaced this run: not a failure. Start the attempt again on the current main.
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub cancelled the CI run for ${prep.commit.slice(0, 12)} because a newer run on the same branch (${o.newerSha.slice(0, 12)}) replaced it. No test failed; the merge starts again. Nothing to do.` });
        return { outcome: "lock_wait", delivered: null, detail: { status: "ci_superseded", newerSha: o.newerSha } };
      case "cancelled": {
        const what = o.runs.join(", ") || "the CI run";
        // BOS-1873: owner-first: re-running the run is done on GitHub, which only the owner can reach.
        await checkStuck(t, "GitHub CI", `was cancelled on GitHub (${what})${o.rerunTried ? ", and cancelled again after one re-run" : "; Boss Man's token couldn't re-run it (it needs Actions: Read and write)"}. No test failed. Open the run on GitHub and re-run it, then choose "${CHECK_AGAIN}"`, "", { tier: "owner" });
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
        // BOS-1733: what the gate tried before sending it back.
        const tried = o.retried
          ? "\n\nIt failed on GitHub twice: once, then again after Boss Man re-ran the failed jobs, so it isn't a one-off."
          : o.why
            ? `\n\nBoss Man didn't ask GitHub for a retry: ${o.why}.${o.gateOutput ? `\n\nBoss Man's re-run on the merge commit, last output:\n${o.gateOutput}` : ""}`
            : "";
        const delivered = await sendBack(
          `The review was approved, but GitHub CI failed on the merge of your branch with ${defaultBranch} (commit ${prep.commit.slice(0, 12)}), so it can't be merged yet. Failed:\n${body}${tried}\n\nFix it on your branch (merge origin/${defaultBranch} in if the failure comes from the two together), run the checks${verifyCommand ? ` (\`${verifyCommand}\`)` : ""}, commit, then move the ticket back to review.${loop.circular ? DIFFERENT_APPROACH(loop.count) : ""}`,
          "ci failed",
          `GitHub CI failed on commit ${prep.commit.slice(0, 12)} (${jobs.join(", ") || "workflow failed before any job ran"})`,
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
      // BOS-1820: a refreshed merge publishes a new commit to the same CI branch next. Wait for the old wait to end (it
      // sees the stop and deletes the branch) so that delete can't land after the new push.
      if ((r as { status?: string }).status === "refreshed") await ciP.catch(() => undefined);
      else ciP.catch(() => undefined);
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
  // Merge train: the check that failed once, then passed its one re-run (a flaky test), named on the landing's result.
  let flakyCheck: string | null = null;
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
            if (r.status === "passed") flakyCheck = failedCheck;
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
  // The attempt ended inside the split merge (BOS-1070): CI failed or couldn't be read, or the legacy check failed.
  if (m1.status === "early") return m1.result;
  // The ticket left review while its merge waited (in or for the train, on its check job: BOS-1757, BOS-1769, or for the
  // landing turn: BOS-1762); nothing was pushed.
  if (m1.status === "left_review") return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while its merge check waited or ran, or while it waited in the merge train or for the landing turn, so nothing was merged." } };
  if (m1.status === "handed_over") return { outcome: "check_stuck", delivered: null, detail: { note: "Handed over while the merge waited (in the merge train or on its check job); the server now in charge restarts it." } };
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
    await checkStuck(t, named(m0.command), `stopped: ${m0.reason}`, m0.output);
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
  // BOS-1821: main moved; merges waiting for another ticket's landing turn ask again whether they can still be carried.
  if (m.status === "merged") landingTurns.landed(t.projectId);
  // The CI branch has done its job (BOS-1070); deleted so the host doesn't collect one per merge. Best effort.
  if (ci && m.status === "merged") void ask<MergeResult>((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: "unpublish", phase: "unpublish" }), MERGE_WAIT_MS).catch(() => undefined);
  // BOS-690 (DR-037): the gate renumbered a clashing migration itself. One line, no wake, no card: nothing for anyone to do.
  if (m.status === "merged" && m.renamed?.length) {
    const names = m.renamed.map((r) => `${r.from} landed as ${r.to}`).join("; ");
    await record(db, { companyId: t.companyId, ticketId, kind: "migration_renamed", summary: `Migration ${names}; the SQL is unchanged, renamed by the merge gate because another ticket took the number first.` });
  }
  // BOS-1762: landed across a main move without a new test. One line, no wake, no card; main's own CI checks the result.
  if (m.status === "merged" && m.carried) {
    const c = m.carried;
    await record(db, { companyId: t.companyId, ticketId, kind: "merge_carried", summary: `Landed on ${defaultBranch} at ${c.to.slice(0, 12)} without a new test: the ${c.commits} commit${c.commits === 1 ? "" : "s"} that reached ${defaultBranch} after its checks passed (on ${c.from.slice(0, 12)}) touch ${c.files} file${c.files === 1 ? "" : "s"}, none of this ticket's. ${defaultBranch}'s own CI checks the result. Nothing to do.` });
  }
  // BOS-316: what was pushed is exactly the tree a merge job just passed, so main passes its check (P11a). Not for a carried
  // merge (BOS-1762): its tree is the passed one plus main's newer files, which no check here has run on.
  if (serverChecks && m.status === "merged" && !m.carried) await queue.setMainState(t.projectId, "green", m.commit);
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
}

/**
 * Merges the ticket's pull request if the host allows it now (R59). If not (approvals or
 * status checks still needed, or someone else must merge), the ticket waits in review with
 * the host's reason; the sync tries again, and finishes the ticket if it's merged on the host.
 */
export async function mergePullRequest(this: ReviewSelf, ctx: ReviewCtx, ticketId: string): Promise<{ outcome: "merged" | "pull_request"; delivered: string | null; detail?: unknown }> {
  const { deps, ticketWithRepo, prTarget, closeAfterMerge, otherOpenBranches, carriedOnHost, wait } = ctx;
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
}
