// Publishing a commit for the git host's CI and reading the result (BOS-1070, BOS-1630), shared by the merge gate
// (services/review.ts, at landing) and the pre-flight run for a branch that changes CI or image files (BOS-1664).
// Nothing here knows about tickets or the database: callers pass what to ask the runner and where to say what happens.
import type { MergeResult } from "@boss-man/shared";
import { GitHostError, type CiStatus, type GitHostConfig, type gitHostService } from "./git-hosts.js";

/** BOS-1070: how the gate waits for CI. Tests pass shorter ones through deps.ciTiming. */
export const CI_TIMING = {
  /** How often the CI result is read. */
  pollMs: 30_000,
  /** No CI run at all this long after the push: the workflow doesn't run on bossman-ci/**, so the gate merges on its own check. */
  graceMs: 10 * 60_000,
  /** CI still running after this: a card, and the ticket stays in review. */
  ceilingMs: 90 * 60_000,
  /** First pause after a failed read of the CI result (5xx, timeout); it doubles, and the 4th failure stops with a card. */
  retryMs: 15_000,
};
export type CiTiming = typeof CI_TIMING;

/** BOS-1070: how a wait for the git host's CI ended. "stopped": the gate's own check failed first, so CI no longer mattered. */
export type CiOutcome =
  /** `flaky` (BOS-1733): test files that failed once, passed at the gate and then passed GitHub's one retry. */
  | { kind: "passed"; reused?: boolean; flaky?: string[]; retryRunUrl?: string }
  | { kind: "none" }
  | { kind: "no_workflows" }
  | { kind: "stopped" }
  /**
   * BOS-1733: `retried`: GitHub's one retry was spent and it failed again. `why`: why no retry was given (one line).
   * `gateOutput`: the end of the gate's own re-run of the named tests, when that failed too.
   */
  | { kind: "failed"; status: CiStatus; retried?: boolean; why?: string; gateOutput?: string }
  /**
   * R40 (BOS-1685): it failed only in main's known GitHub-only red, which this branch doesn't touch. Not in ciStops on
   * purpose: the gate's own check must still finish and pass before the merge goes on. Set by the merge gate, never here.
   */
  | { kind: "known_red"; jobs: string[]; refs: string[] }
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string }
  | { kind: "timeout"; waiting: string[] }
  /** GitHub cancelled this commit's run because a newer run on the same branch replaced it: nothing failed, the attempt starts again. */
  | { kind: "superseded"; newerSha: string }
  /** GitHub cancelled the run with no newer run behind it, and one re-run didn't help (or wasn't allowed). Not a test failure. */
  | { kind: "cancelled"; runs: string[]; rerunTried: boolean };
/** Outcomes that end a merge attempt without merging: the other side (the gate's own check) need not finish. */
export const ciStops = (o: CiOutcome) => o.kind === "failed" || o.kind === "refused" || o.kind === "error" || o.kind === "timeout" || o.kind === "superseded" || o.kind === "cancelled";
/** Shared by the gate's own check and the CI wait running beside it: set by whichever ends the attempt first. */
export type CiStop = { stopped: boolean };

/** The runner answered the publish with something other than "published". */
export class CiPublishError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type CiTarget = { cfg: GitHostConfig; token: string };
type Hosts = Pick<ReturnType<typeof gitHostService>, "ciStatus" | "workflowRuns" | "rerunRun"> & Partial<Pick<ReturnType<typeof gitHostService>, "rerunFailedJobs">>;

/**
 * BOS-1733: what the gate decided about a GitHub failure. `retry`: the named tests passed at the gate, so GitHub may re-run its
 * failed jobs once; `files` are those tests. Otherwise `why` says why not, and `gateOutput` carries the gate's failing re-run.
 */
export type FlakeAnswer = { retry: true; files: string[] } | { retry: false; why: string; gateOutput?: string };

/**
 * One read of CI on a commit; a temporary failure (5xx, timeout) is asked again 3 times with a growing pause.
 * A refusal (401/403/404) is never retried: the token lacks Actions: Read-only or can't see the repo.
 */
export async function readCi(hosts: Hosts, target: CiTarget, sha: string, stop: CiStop, timing: Pick<CiTiming, "retryMs">): Promise<CiStatus | CiOutcome> {
  for (let fails = 0; ; fails++) {
    try {
      return await hosts.ciStatus(target.cfg, target.token, sha);
    } catch (err) {
      if (err instanceof GitHostError && [401, 403, 404].includes(err.status)) return { kind: "refused", message: err.message };
      if (fails >= 3) return { kind: "error", message: (err as Error).message };
      await sleep(timing.retryMs * 2 ** fails);
      if (stop.stopped) return { kind: "stopped" };
    }
  }
}

export type PublishDeps = {
  hosts: Hosts;
  target: CiTarget;
  timing: CiTiming;
  /** Asks the runner to push `commit` to the ticket's bossman-ci branch (workspace.merge, phase "publish"). */
  publish: (commit: string) => Promise<MergeResult>;
  /** Says in the ticket's activity that the push happened. */
  announce: (branch: string) => Promise<void>;
  /** Says in the ticket's activity that GitHub was asked to re-run a cancelled run. */
  announceRerun?: (commit: string) => Promise<void>;
  /** Told when the wait starts (`waiting` empty), each poll, and `null` when it ends. */
  onWait?: (state: { since: number; waiting: string[] } | null) => void;
  /** Called every poll, to keep the caller's own activity beat alive. */
  touch?: () => PromiseLike<unknown>;
  /** Trees CI already passed; the same tree on new parents keeps its pass (P11a). */
  passedTrees?: Set<string>;
  /**
   * BOS-1733: asked once per wait when CI fails. The merge gate (server check queue) passes it; the pre-flight doesn't, so a
   * failure there ends the wait as before. Called while the gate's own check may still run; `stop` says when it failed.
   */
  flakeRetry?: (s: CiStatus, stop: CiStop) => Promise<FlakeAnswer>;
  /** Says in the ticket's activity that GitHub was asked to re-run the failed jobs, or refused. */
  announceFlakeRetry?: (files: string[], accepted: boolean) => Promise<void>;
};

/** BOS-1733: the token couldn't re-run the failed jobs. */
export const RERUN_REFUSED = "the git token can't re-run GitHub jobs (it needs Actions: Read and write)";

/** Pushes the commit for CI and waits for the run to end. The merge gate and the pre-flight both call it. */
export async function publishAndWait(deps: PublishDeps, prep: { commit: string; tree: string; targetSha: string }, stop: CiStop): Promise<CiOutcome> {
  if (deps.passedTrees?.has(prep.tree)) return { kind: "passed", reused: true };
  // Asked on the target's head before anything is pushed, so a token that can't read Actions runs costs no CI run.
  const probe = await readCi(deps.hosts, deps.target, prep.targetSha, stop, deps.timing);
  if ("kind" in probe) return probe;
  const pub = await deps.publish(prep.commit);
  if (pub.status !== "published") throw new CiPublishError(`The runner answered the CI publish with "${pub.status}"; nothing was merged.`);
  if (!pub.hasWorkflows) return { kind: "no_workflows" };
  await deps.announce(pub.branch);
  const since = Date.now();
  deps.onWait?.({ since, waiting: [] });
  // A cancelled run is never a failure (nothing was tested). One re-run is tried when no newer run replaced it; the
  // run's state is read as still pending for a few polls after, as GitHub takes a moment to show it queued again.
  let rerunAt: number | null = null;
  // BOS-1733: the one retry of failed jobs for a flaky test: when it was asked for, and the test files it was for.
  let flakeAt: number | null = null;
  let flaky: string[] | null = null;
  let retryRunUrl: string | undefined;
  try {
    for (;;) {
      if (stop.stopped) return { kind: "stopped" };
      const s = await readCi(deps.hosts, deps.target, prep.commit, stop, deps.timing);
      if ("kind" in s) return s;
      if (s.state === "passed") return flaky ? { kind: "passed", flaky, ...(retryRunUrl ? { retryRunUrl } : {}) } : { kind: "passed" };
      // Right after the retry GitHub may still show the old failed attempt for a moment: read it as pending, as for rerunAt.
      const inGrace = flakeAt !== null && Date.now() - flakeAt < deps.timing.pollMs * 3;
      if (s.state === "failed" && !inGrace) {
        if (flaky) return { kind: "failed", status: s, retried: true };
        if (!deps.flakeRetry || !deps.hosts.rerunFailedJobs) return { kind: "failed", status: s };
        const a = await deps.flakeRetry(s, stop);
        // The gate's own check failed while the named tests were re-run: its send-back is the one the agent gets.
        if (stop.stopped) return { kind: "stopped" };
        if (!a.retry) return { kind: "failed", status: s, why: a.why, ...(a.gateOutput ? { gateOutput: a.gateOutput } : {}) };
        const runIds = [...new Set(s.failed.map((r) => r.runId).filter((id): id is number => !!id))];
        let accepted = runIds.length > 0;
        for (const id of runIds) if (!(await deps.hosts.rerunFailedJobs(deps.target.cfg, deps.target.token, id))) accepted = false;
        await deps.announceFlakeRetry?.(a.files, accepted);
        if (!accepted) return { kind: "failed", status: s, why: RERUN_REFUSED };
        flaky = a.files;
        flakeAt = Date.now();
        retryRunUrl = s.failed[0]?.url || undefined;
      }
      if (s.state === "cancelled" && !(rerunAt !== null && Date.now() - rerunAt < deps.timing.pollMs * 3)) {
        const mine = s.cancelled![0]!;
        const branchRuns = await deps.hosts.workflowRuns(deps.target.cfg, deps.target.token, pub.branch).catch(() => []);
        const own = branchRuns.find((r) => r.id === mine.id);
        // A run for another commit, started after this one: the branch was pushed again and that push replaced this run.
        const newer = branchRuns.find((r) => r.headSha !== prep.commit && (!own || r.createdAt > own.createdAt));
        if (newer) return { kind: "superseded", newerSha: newer.headSha };
        const runs = s.cancelled!.map((r) => r.name);
        if (rerunAt !== null) return { kind: "cancelled", runs, rerunTried: true };
        if (!(await deps.hosts.rerunRun(deps.target.cfg, deps.target.token, mine.id))) return { kind: "cancelled", runs, rerunTried: false };
        rerunAt = Date.now();
        await deps.announceRerun?.(prep.commit);
      }
      const waited = Date.now() - since;
      if (s.state === "none" && waited >= deps.timing.graceMs) return { kind: "none" };
      // After the flaky retry the ceiling counts from the retry: the retried jobs get the same time the first run had.
      if (Date.now() - (flakeAt ?? since) >= deps.timing.ceilingMs) return { kind: "timeout", waiting: s.waiting };
      deps.onWait?.({ since, waiting: s.waiting });
      await deps.touch?.();
      await sleep(deps.timing.pollMs);
    }
  } finally {
    deps.onWait?.(null);
  }
}

/** Whether the files a branch changed need GitHub's own jobs: workflows or image paths (the changes job's images_paths in ci.yml). */
export const CI_IMAGES_PATHS = /(^|\/)Dockerfile|^docker-compose|^deploy\/|^scripts\/|^skills\/|^pnpm-lock\.yaml|^\.github\/workflows\/|^apps\/runner\/|check-worker|^packages\/shared\/src\/protocol/;
export const touchesGithubOnlyJobs = (files: string[]) => files.some((f) => CI_IMAGES_PATHS.test(f));
/**
 * BOS-1664 (security, F1): GitHub runs the workflow files of whatever commit is pushed, with a token the workflow can widen, so
 * a branch that edits workflows is NOT pushed before review: its GitHub run happens only at the gate, after the reviews.
 */
export const touchesWorkflows = (files: string[]) => files.some((f) => /^\.github\/workflows\//.test(f));
/** Whether the pre-review GitHub run (and the hold on the move to review) applies to these changed files. */
export const needsEarlyGithubRun = (files: string[]) => touchesGithubOnlyJobs(files) && !touchesWorkflows(files);
