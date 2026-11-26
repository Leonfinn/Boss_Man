// The GitHub CI step of one merge attempt (BOS-1903, move 3 of the BOS-1886 split): region I of landOnce, moved out of
// merge-attempt.ts unchanged. landOnce calls it once, straight after its setup, with the service as `this`, the shared
// context as `ctx` and the attempt's setup values as `a`. It sets `a.ci` and returns the CI wait's closures, which
// landOnce and the merge rounds (merge-rounds.ts) use.
import { and, eq, gt, ne } from "drizzle-orm";
import { ticketRef, type MergeResult, type VerifyResult, VERIFY_ASK_TIMEOUT_MS } from "@boss-man/shared";
import { agents, checkJobs, checkResults, companies, projects, ticketMessages, tickets } from "../db/schema.js";
import { RunnerGone } from "./runners.js";
import { DIFFERENT_APPROACH } from "./loop-guards.js";
import { CiPublishError, ciStops, publishAndWait as ciPublishAndWait, RERUN_REFUSED, withActionsToken, type CiOutcome, type CiStop, type CiTarget, type FlakeAnswer } from "./ci-publish.js";
import { BASELINE_RUNS, CANT_RERUN_EXIT, describeSlow, FLAKE_RETRY_KIND, flakeDecision, gateRerunCommand, namedTestFiles, RETRIES_PER_WEEK, RETRY_WINDOW_MS, retryCounts, SLOW_RETRIES_PER_WEEK, SLOW_ROW_PREFIX, slowJobs, slowRetryCounts, TOUCHED_EXIT, type SlowEvidence, type SlowJob } from "./ci-flake.js";
import type { CancelAnswer, CiRun, CiStatus } from "./git-hosts.js";
import { CHECK_AGAIN } from "./decisions.js";
import { ensureCiIdentityCard } from "./ci-identity-card.js";
import { record } from "./activity.js";
import { lineEvent } from "./merge-line.js";
import { touchesScope } from "./review-holds.js";
import { knownRedOnly, mainCiFailures, namedFiles, type BranchFailure, type OpenFailure } from "./main-ci.js";
import { CHECK_JOB_POLL_MS, checkNeverFinished, checkVerdict, checkWaitedForLock, ciBounceRecord, FLAKE_RERUN_MAX_MS, HANDED_OVER_WHY, INFRA_CAUSE_TEXT, INFRA_RETRY_ATTEMPTS, INFRA_RETRY_BASE_MS, MERGE_WAIT_MS, ReviewError, type InfraCause, type LandOnceResult } from "./review-common.js";
import type { ReviewCtx } from "./review-ctx.js";
import type { ReviewSelf } from "./review.js";
import type { MergeAttempt } from "./merge-attempt.js";

export type Early = { status: "early"; result: LandOnceResult };

/** BOS-2360: the start of a CiStop's `why` when a merge-train member stopped waiting because a GitHub pass behind it covers it. */
export const COVERED_WHY = "is covered by";

export async function ciStep(this: ReviewSelf, ctx: ReviewCtx, a: MergeAttempt) {
  const { db, deps, gate, queue, scanListWarning, phases, ciWaits, ciPassedTrees, ciCardWaiting, ciTiming, prTarget, approvedAndWaiting, tellCeo, checkStuck, waitForCi, holdForWaits } = ctx;
  const { t, ticketId, opts, runner, repoUrl, defaultBranch, verifyCommand, landing, gitHost, gitApiBase, touch, ask, sendBack, keepBounce, whileActive, readDiff, changed, checks, named, kindOf, timedCheck, checkFailed, checkPrio, serverChecks, checkMerged } = a;
  // BOS-1070: with the owner's switch on, a GitHub project's merge also waits for GitHub CI on the exact merge commit.
  // The gate pushes that commit to bossman-ci/<ticket>, reads its Actions runs (BOS-1630), and merges only on green.
  // Everything here sits behind the switch: off, the flow below is unchanged.
  let ci: CiTarget | null = null;
  if (!opts?.skipChecks && landing !== "pull_request" && gitHost === "github" && deps.gitHosts && (await waitForCi())) {
    if (!deps.runners.can(runner.id, "ci-publish")) {
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: "Waiting for GitHub CI is on, but this company's runner is too old to push the merge for CI, so this merge goes ahead on Boss Man's own check only. Update the runners: Settings → Server and runner → Updates → Build and update runners." });
    } else {
      ci = await prTarget(t.companyId, repoUrl, gitHost, gitApiBase).catch((err: Error) => {
        throw new ReviewError(409, `Waiting for GitHub CI is on, but Boss Man can't read GitHub for this project: ${err.message}`);
      });
      // BOS-2285: the gate's CI pushes email whoever's token pushes them; ask once for a second account's token.
      const ciToken = await deps.gitCiToken?.(t.companyId).catch(() => undefined);
      await ensureCiIdentityCard(db, t.companyId, ciToken);
      // BOS-2345: with that token granted, the gate's Actions writes (the one flake retry, re-run, cancel) go out with it first.
      if (ciToken) ci = { ...ci, actionsToken: ciToken };
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
        ...(serverChecks && deps.cancelCheck ? { flakeRetry: (s: CiStatus, st: CiStop) => flakeRetry(prep, s, st), announceFlakeRetry: (a: { files: string[]; slow?: SlowJob[] }, accepted: boolean, refused?: string) => announceFlakeRetry(prep, a, accepted, refused) } : {}),
      },
      prep,
      stop,
    ).then(
      async (got) => {
        // R40: a failure that is only main's known red becomes known_red, which lets the gate's own check finish.
        const red = got.kind === "failed" && !got.status.billing ? await knownRed(got.status) : null;
        const o: CiOutcome = red ? { kind: "known_red", ...red } : got;
        await endCiWait(o.kind);
        if (o.kind === "stopped") await cancelAbandoned(prep.commit, stop.why);
        if (o.kind === "failed") await ctx.wakeCiWatchers(t, o.kind);
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
  /**
   * BOS-2301: the gate stopped waiting for GitHub on a copy it pushed (its own check failed, the ticket left review, main
   * moved and the merge was rebuilt, ...). Its run would otherwise go on with nobody waiting, go red and email the owner
   * about a merge Boss Man had already dropped (run 4231, BOS-2285, 22 Nov). Cancel what is still going; when GitHub
   * refuses (the token needs Actions: Read and write), say on the ticket that the run goes on and that its result doesn't
   * count. A copy that handed over leaves the runs alone: the server now in charge may be waiting on the same commit.
   */
  const cancelAbandoned = async (commit: string, why: string | undefined) => {
    if (!ciPushed || !deps.gitHosts?.cancelRuns) return;
    if (deps.isLeader && !deps.isLeader()) return;
    const because = why ? ` (${why})` : "";
    const cancel = (token: string): Promise<CancelAnswer> => deps.gitHosts!.cancelRuns(ci!.cfg, token, commit).catch((err: Error) => ({ cancelled: 0, still: null, refused: err.message.slice(0, 200) }));
    // BOS-2345: the second account's token first; GIT_TOKEN cancels what it left going. Cancelled counts add up.
    const { got: last, first } = await withActionsToken(ci!, cancel, (r) => r.still === 0);
    const got: CancelAnswer = first ? { ...last, cancelled: first.cancelled + last.cancelled } : last;
    if (!got.cancelled && got.still === 0) return;
    const sha = commit.slice(0, 12);
    // Activity summaries are cut at 300 characters: what the reader needs comes first, GitHub's own answer last.
    const going = got.still === null ? "Its GitHub run may still be going" : got.still > 1 ? `${got.still} GitHub runs on it are still going` : "Its GitHub run is still going";
    const summary =
      got.still === 0
        ? `Stopped waiting for GitHub CI on ${sha}${because} and cancelled its GitHub run${got.cancelled > 1 ? "s" : ""}, so no result comes for a merge copy Boss Man dropped. Nothing to do.`
        : `Stopped waiting for GitHub CI on ${sha}${because}. ${going} and no longer counts: ignore a GitHub email about ${sha}. Couldn't cancel: ${got.refused ?? "no reason given"}`;
    await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary });
  };
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
    const switchOff = `To stop waiting for GitHub CI instead, turn off "Wait for GitHub CI" in Settings → Server and runner → Limits and checks, then choose "${CHECK_AGAIN}".`;
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
  // not state: one landing attempt's slow-machine retry counts per job (BOS-2082), dropped when it returns.
  let slowCounts = new Map<string, number>();
  /**
   * BOS-2082: the failed jobs, when every one ran on a slow GitHub machine (ci-flake.ts slowJobs). GitHub's history is only
   * read when each failed job could qualify: its failures are all timeouts, and its failed step, time and workflow are known.
   */
  const slowFacts = async (s: CiStatus, found: Array<{ run: CiRun; timeoutsOnly?: boolean }>): Promise<SlowJob[] | null> => {
    const jobs = s.failed.map((run) => ({ run, timeoutsOnly: !!found.find((f) => f.run === run)?.timeoutsOnly }));
    if (!jobs.length || jobs.some((j) => !j.timeoutsOnly || !j.run.step || j.run.stepSeconds === undefined || !j.run.workflowId)) return null;
    const ev: SlowEvidence[] = [];
    for (const { run, timeoutsOnly } of jobs) {
      const baseline = await deps.gitHosts!.stepTimes(ci!.cfg, ci!.token, { workflowId: run.workflowId!, job: run.name, step: run.step!, ...(run.runId ? { exceptRunId: run.runId } : {}), want: BASELINE_RUNS }).catch(() => [] as number[]);
      ev.push({ job: run.name, step: run.step!, seconds: run.stepSeconds!, baseline, timeoutsOnly });
    }
    return slowJobs(ev);
  };
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
    slowCounts = slowRetryCounts(rows.map((r) => r.detail));
    const d = flakeDecision({
      billing: !!s.billing || found.some((f) => f.billing),
      slow: await slowFacts(s, found),
      slowRecent: slowCounts,
      named,
      changed: diff ? diff.files.map((f) => f.path) : null,
      mainRed: proj?.s === "red",
      retriedThisCommit: rows.some((r) => r.sha === prep.commit),
      recent: flakeCounts,
    });
    if (d.act === "bounce") return { retry: false, why: d.why };
    // BOS-2082: a slow GitHub machine: nothing to re-run here; GitHub's retry of the failed jobs gets a fresh machine.
    if (d.act === "retry_slow") return { retry: true, files: [], slow: d.jobs };
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
        // BOS-2360: a merge-train member also stops when a GitHub pass behind it covers it (stop.why says so).
        const first = stop.why?.startsWith(COVERED_WHY) ? `It ${stop.why}` : "Boss Man's own merge check failed first";
        await deps.cancelCheck?.(cur.id, stop.stopped ? `${first}, so the re-run of GitHub's failed tests was stopped.` : "The re-run of GitHub's failed tests took too long, so it was stopped.").catch(() => undefined);
        return { retry: false, why: stop.stopped ? first : `the re-run at Boss Man's gate didn't finish within ${Math.round(FLAKE_RERUN_MAX_MS / 60_000)} minutes` };
      }
      await touch();
      await new Promise((resolve) => setTimeout(resolve, CHECK_JOB_POLL_MS));
      const [row] = await db.select().from(checkJobs).where(eq(checkJobs.id, cur.id));
      if (!row) return { retry: false, why: "the re-run at Boss Man's gate disappeared from the check queue" };
      cur = row;
    }
    if (cur.state === "passed") return { retry: true, files };
    const tail = cur.logTail ?? "";
    // BOS-2758: the repo's own rule says the branch touches a shell test that failed: the failure is the branch's.
    if (cur.state === "failed" && cur.exitCode === TOUCHED_EXIT) {
      const said = [...tail.matchAll(/^boss-man re-run: (.+): the branch changes what it tests/gm)].pop()?.[1];
      return { retry: false, why: `the branch changes what ${said ?? files.join(", ")} tests (the same rule the quick check uses to pick shell tests)` };
    }
    if (cur.state === "failed" && cur.exitCode !== CANT_RERUN_EXIT && !/timed out/i.test(cur.reason ?? "")) {
      return { retry: false, why: `${files.join(", ")} failed again when Boss Man re-ran ${files.length > 1 ? "them" : "it"} on the same merge commit, so the failure is real`, gateOutput: tail.slice(-3000) };
    }
    const said = [...tail.matchAll(/^boss-man re-run: (.+)$/gm)].pop()?.[1];
    return { retry: false, why: `Boss Man couldn't re-run ${files.length > 1 ? "them" : "it"} at its gate (${(cur.state === "failed" && cur.exitCode === CANT_RERUN_EXIT && said ? said : cur.reason ?? cur.state).slice(0, 200)})` };
  };
  /**
   * One landing attempt's accepted GitHub retries, by merge commit: the test files that failed once and passed
   * when the gate re-ran them. A merge-train member covered by a pass behind it while its retry still runs (BOS-2360) has
   * its wait stopped, so no retry result comes back; ciCovered reports these files to the CEO instead.
   */
  // not state: local to this landing attempt's closure, gone when the attempt ends.
  const retriedFlaky = new Map<string, string[]>();
  // The one retry is recorded only once GitHub accepted it: the record is what the per-commit and per-week limits count.
  const announceFlakeRetry = async (prep: { commit: string }, { files, slow }: { files: string[]; slow?: SlowJob[] }, accepted: boolean, refused?: string) => {
    // BOS-2082: GitHub's own answer, so the activity says why (on 21 Nov it said only "needs Actions: Read and write").
    const no = `Boss Man couldn't get the retry: ${refused ?? RERUN_REFUSED}`;
    if (slow?.length) {
      const what = `GitHub CI failed with timeouts on a slow GitHub machine: ${describeSlow(slow)}`;
      if (!accepted) {
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `${what}. ${no}, so the ticket goes back as before.` });
        return;
      }
      await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: prep.commit, kind: FLAKE_RETRY_KIND, passed: true, detail: slow.map((j) => `${SLOW_ROW_PREFIX}${j.job}`).join("\n") });
      const counts = slow.map((j) => `${j.job}: slow-machine retry ${(slowCounts.get(j.job) ?? 0) + 1} of ${SLOW_RETRIES_PER_WEEK} this week`).join("; ");
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `${what}. Boss Man asked GitHub to re-run the failed jobs once on a fresh machine (${counts}). Nothing to do.` });
      return;
    }
    if (!accepted) {
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `${files.join(", ")} passed when Boss Man re-ran ${files.length > 1 ? "them" : "it"}, but ${no.charAt(0).toLowerCase()}${no.slice(1)}, so the ticket goes back as before.` });
      return;
    }
    await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: prep.commit, kind: FLAKE_RETRY_KIND, passed: true, detail: files.join("\n") });
    retriedFlaky.set(prep.commit, files);
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
        if (o.slow?.length) await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub CI passed on its one retry on a fresh machine, so the timeouts came from a slow GitHub machine, not this branch. Nothing to do.` });
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
  /**
   * BOS-2360: a merge-train member lands on the GitHub pass of a ticket behind it (`by`, on commit `byCommit`), whose stacked
   * tree holds this change. Its own run was stopped (and cancelled) or had failed (`failed`, after the gate's flake handling).
   * The "ci" pass row names the covering commit; the passed trees get only trees GitHub really ran. A failure that a pass
   * behind it covers is a one-off: the files GitHub named go to the CEO's flaky-test tickets, as after a passed retry.
   */
  const ciCovered = async (prep: { commit: string; tree: string }, cover: { by: string; byRef: string; byCommit: string }, failed: Extract<CiOutcome, { kind: "failed" }> | null) => {
    await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: prep.commit, kind: "ci", passed: true, detail: `covered by ${cover.byCommit}` });
    await lineEvent(db, t, { event: "ci_covered", by: cover.by, commit: cover.byCommit, ...(failed ? { failed: true } : {}) });
    const sha = cover.byCommit.slice(0, 12);
    // A pass behind arrived while GitHub's one retry of this commit's flaky tests was still going: they failed once on
    // GitHub and passed at the gate, so they are a one-off the CEO hears about, as after a passed retry.
    const retried = retriedFlaky.get(prep.commit) ?? [];
    if (!failed && retried.length) {
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub CI failed once in ${retried.join(", ")} on ${prep.commit.slice(0, 12)}; while its retry ran, GitHub CI passed on ${sha}, the merge of ${cover.byRef} stacked on this one, which holds this change: a one-off failure, so it lands. Boss Man told the CEO about the flaky test. Nothing to do.` });
      await reportFlaky(retried, undefined, prep.commit).catch(() => undefined);
    } else if (!failed) {
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub CI passed on ${sha}, the merge of ${cover.byRef} stacked on this one in the merge train, so this change passed GitHub there and lands without waiting for its own run. Nothing to do.` });
    } else {
      const found = await deps.gitHosts!.failures(ci!.cfg, ci!.token, failed.status.failed).catch(() => []);
      const named = namedTestFiles(failed.status.failed.map((run) => ({ job: run.name, paths: found.find((f) => f.run === run)?.paths ?? null })));
      const jobs = failed.status.failed.map((r) => r.name).join(", ") || "the workflow";
      await record(db, { companyId: t.companyId, ticketId, kind: "merge_ci", summary: `GitHub CI failed in ${jobs} on ${prep.commit.slice(0, 12)}, but passed on ${sha}, the merge of ${cover.byRef} stacked on this one, which holds this change: a one-off failure, so it lands.${named.files.length ? " Boss Man told the CEO about the flaky test." : ""} Nothing to do.` });
      if (named.files.length) await reportFlaky(named.files, failed.status.failed[0]?.url || undefined, prep.commit).catch(() => undefined);
    }
    startCiWaiters();
  };
  /** BOS-2301: why the gate's own side ended the attempt, in a few words for the ticket (cancelAbandoned). */
  const stopWhy = (r: object): string => {
    switch ((r as { status?: string }).status) {
      case "refreshed":
        return "main changed, so the merge was rebuilt on it";
      case "left_review":
        return "the ticket left review";
      case "check_failed":
        return "Boss Man's own merge check failed";
      case "early":
        return "Boss Man's own check ended the merge attempt";
      case "job_stuck":
        return "Boss Man's own merge check couldn't finish";
      case "job_superseded":
        return "a newer check of this ticket replaced it";
      case "branch_moved":
        return "the branch got a new commit";
      case "handed_over":
        return "another copy of the server took over";
      default:
        return "the merge attempt ended";
    }
  };
  // The gate's own check and the CI wait side by side. Whichever ends the attempt first (a failure) stops the other;
  // its later result is dropped, so the ticket is never sent back twice.
  const alongsideCi = async <O extends object>(prep: { commit: string; tree: string; targetSha: string }, own: (stop: CiStop) => Promise<O | null>): Promise<O | Early | null> => {
    if (!ci) return own({ stopped: false });
    const stop: CiStop = { stopped: false };
    const ownP = own(stop).then(
      (r) => {
        if (r) {
          stop.why ??= stopWhy(r);
          stop.stopped = true;
        }
        return r;
      },
      (e: unknown) => {
        // The gate's own check threw (the runner went away): stop the CI poll too, or it holds this landing for up to
        // the CI ceiling before the error reaches the retry.
        stop.why ??= `the merge attempt stopped: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
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
  a.ci = ci;
  return { publishAndWait, ciVerdict, alongsideCi, legacyChecks, ciCovered, stopWhy };
}

export type CiStepParts = Awaited<ReturnType<typeof ciStep>>;
