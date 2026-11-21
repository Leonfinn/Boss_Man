// One merge attempt of the review service (BOS-1902, move 2 of the BOS-1886 split): landOnce and mergePullRequest, moved
// out of review.ts whole. Each takes the service as `this` (so calls to other methods go through the assembled object,
// where tests spy on them) and the shared context as `ctx`. review.ts keeps one delegate line per method.
// BOS-1903 (move 3): landOnce keeps its setup and its outcome; its GitHub CI step is in merge-ci-step.ts and its merge
// rounds are in merge-rounds.ts. Both take the setup's values through the attempt object (MergeAttempt below).
import { and, eq, inArray } from "drizzle-orm";
import { ownerApprovedFiles } from "@boss-man/shared";
import { checkFailureFacts, fullLogPointer, deepChecks, renderTemplate, RISK_TIERS, riskOf, type MergeResult, type PushResult, type VerifyResult, type WorkspaceDiff } from "@boss-man/shared";
import { checkJobs, checkResults, runners, ticketMessages, tickets } from "../db/schema.js";
import { RunnerGone } from "./runners.js";
import { DIFFERENT_APPROACH } from "./loop-guards.js";
import { GitHostError, type GitHostConfig } from "./git-hosts.js";
import { latestRows } from "./review-kinds.js";
import { supersedeSignoffs } from "./decisions.js";
import { ticketCheckPriority } from "./check-gate.js";
import { SUPERSEDED_TEXT } from "./check-queue.js";
import { record } from "./activity.js";
import { leftLineSince, lineEvent, type CheckWay } from "./merge-line.js";
import { tellCeoLineHolderSentBack } from "./line-holder.js";
import { landingTurns } from "./landing-turn.js";
import { checkNeverFinished, checkQueueStuck, checkWaitedForLock, FULL_CHECK_NEXT, gateBounceRecord, INFRA_CAUSE_TEXT, INFRA_RETRY_ATTEMPTS, INFRA_RETRY_BASE_MS, MERGE_ACTIVITY_MS, MERGE_WAIT_MS, NOTHING_CHANGED, ReviewError, RUNNER_WAIT_MS, type CarriedInfo, type InfraCause, type LandOptions } from "./review-common.js";
import type { ReviewCtx } from "./review-ctx.js";
import type { ReviewSelf } from "./review.js";
import { ciStep } from "./merge-ci-step.js";
import { recordBranchFiles } from "./branch-overlaps.js";
import { mergeRounds } from "./merge-rounds.js";

type TicketRepo = Awaited<ReturnType<ReviewCtx["ticketWithRepo"]>>;
/**
 * BOS-1903: what landOnce's setup hands its CI step (merge-ci-step.ts) and its merge rounds (merge-rounds.ts). Each field
 * is the setup's local of the same name, and every one is final by the time the attempt is built (`pin` changes later,
 * inside askMerge, so it stays private there). The parts write two fields, both read by landOnce's outcome: `ci`, set by
 * the CI step, and `flakyCheck`, set by a merge-train re-run.
 */
export type MergeAttempt = {
  t: TicketRepo["t"];
  ticketId: string;
  opts: LandOptions | undefined;
  runner: { id: string };
  repoUrl: string;
  defaultBranch: TicketRepo["defaultBranch"];
  verifyCommand: TicketRepo["verifyCommand"];
  landing: TicketRepo["landing"];
  gitHost: TicketRepo["gitHost"];
  gitApiBase: TicketRepo["gitApiBase"];
  touch: () => ReturnType<ReviewCtx["beatNow"]>;
  inReview: () => Promise<boolean>;
  leftReview: () => Promise<boolean>;
  ask: <T>(build: (requestId: string) => Parameters<ReviewCtx["deps"]["runners"]["send"]>[1], timeoutMs: number) => Promise<T>;
  sendBack: (text: string, reason: string, what?: string) => Promise<Awaited<ReturnType<ReviewCtx["tellAgent"]>>>;
  keepBounce: (text: string) => Promise<void>;
  whileActive: <T>(work: () => Promise<T>) => Promise<T>;
  readDiff: () => Promise<WorkspaceDiff | null>;
  changed: WorkspaceDiff | null;
  askMerge: <R extends MergeResult | PushResult = MergeResult>(build: (requestId: string) => Record<string, unknown>, timeoutMs: number) => Promise<R>;
  checks: string[];
  combinedCommand: string | null;
  named: (command: string) => string;
  kindOf: (command: string) => "deep_verify" | "verify";
  timedCheck: <T>(check: string, way: CheckWay, slot: (w: () => Promise<T>) => Promise<T>, verdict: (r: T) => boolean | null, work: () => Promise<T>) => Promise<T>;
  checkFailed: (command: string, v: VerifyResult) => Promise<{ outcome: "verify_failed" | "check_stuck" | "lock_wait"; delivered: string | null; detail: unknown }>;
  checkPrio: number;
  serverChecks: boolean;
  checkMerged: boolean;
  ci: { cfg: GitHostConfig; token: string } | null;
  // Merge train: the check that failed once, then passed its one re-run (a flaky test), named on the landing's result.
  flakyCheck: string | null;
};

export async function landOnce(this: ReviewSelf, ctx: ReviewCtx, ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions, begun: Date = new Date()): Promise<{ outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted" | "carried" | "migration_journal" | "branch_changed"; delivered: string | null; detail?: unknown }> {
  const { db, deps, state: reviewState, queue, beatNow, ticketWithRepo, carriedBetween, approvedAndWaiting, refuseUnchecked, refuseCarried, announceMerged, afterMergeLeft, closeAfterMerge, tellCeoLiveFix, pagePriorityMerge, tellCeo, checkStuck, wait, tellAgent, checkMergedResult, templates, holdForWaits, refuseIfHeld } = ctx;
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
  // BOS-2089: why the last read failed, kept for the "restart" failure's note (20 Nov's seven failures left no reason).
  let diffError = "";
  const readDiff = () =>
    whileActive(() => ask<WorkspaceDiff>((requestId) => ({ type: "workspace.diff", requestId, projectId: t.projectId, ticketId, baseRef: defaultBranch }), 60_000)).catch((err: unknown) => {
      if (err instanceof RunnerGone) throw err;
      diffError = String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 150);
      return null;
    });
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
  if (!changed && t.branch) throw new RunnerGone(`The runner couldn't say which files the ticket changes${diffError ? ` (${diffError})` : ""}.`);
  // Keep the files it changes, so the overlap warnings can read them without a runner call (BOS-1411, BOS-2179). Never fails a merge.
  if (changed?.files.length) await recordBranchFiles(db, ticketId, changed.files.map((f) => f.path));
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

  const attempt: MergeAttempt = { t, ticketId, opts, runner, repoUrl, defaultBranch, verifyCommand, landing, gitHost, gitApiBase, touch, inReview, leftReview, ask, sendBack, keepBounce, whileActive, readDiff, changed, askMerge, checks, combinedCommand, named, kindOf, timedCheck, checkFailed, checkPrio, serverChecks, checkMerged, ci: null, flakyCheck: null };
  // BOS-1070: the GitHub CI step (merge-ci-step.ts) sets attempt.ci when this merge waits for GitHub CI.
  const ciParts = await ciStep.call(this, ctx, attempt);
  const { ci } = attempt;
  const { legacyChecks } = ciParts;
  if (!ci) {
    const r = await legacyChecks({ stopped: false });
    if (r) return r;
  }

  // BOS-1540: no migration-number send-back here. The runner's merge renumbers a clashing branch itself
  // (BOS-690) and records migration_renamed; a clash it refuses comes back below as conflicts or migration_journal.

  // The merge itself: server merge, legacy and CI-gated merges, the plain merge or the merge train (merge-rounds.ts).
  const { m1, pr } = await mergeRounds.call(this, ctx, attempt, ciParts);
  const { flakyCheck } = attempt;
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
