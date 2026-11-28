// BOS-2907: GitHub's images job (ci.yml) on a ticket's own CI branch, for `tickets read`. The runners and the merge gate
// have no Docker daemon, so that job is the only place before merge where scripts/install-images.test.sh runs its real
// install steps. Authors and reviewers need to cite how far it got ("images (amd64) reached 'ok the second install answers
// /api/health'"), and the public API needs a sign-in for job logs, so Boss Man reads them with the project's token.
//
// Where the runs are: the ticket's branch is never pushed. Boss Man pushes the branch merged with main to
// bossman-ci/<ticket id> (GitHub CI before review, ci-preflight.ts, and the merge gate's copy), then deletes the branch.
// GitHub still lists those runs by branch name after the delete, so the newest CI run there is the one to show.
import { redactForModel } from "@boss-man/shared";
import { CI_BRANCH_PREFIX, GitHostError, type GitHostConfig, type gitHostService, type WorkflowJob, type WorkflowRun } from "./git-hosts.js";

/** The per-architecture images jobs: "images (amd64)", "images (arm64)"; not "images (join amd64 + arm64)". */
const IMAGES_JOB = /^images \(([a-z0-9_-]+)\)$/i;
const INSTALL_STEP = /^Install from the images/;
/** The install step's own command line, which GitHub echoes at the start of the step's log section. */
const INSTALL_COMMAND = /INSTALL_RELEASE_JSON=.*scripts\/install-images\.test\.sh/;
/** install-images.test.sh's result lines (its ok()/bad() helpers and its skips), and test-shell.sh's failure line. */
const RESULT_LINE = /^(?:ok\s|FAIL\s|skip:|test-shell: FAILED)/;
const LAST_LINES = 3;
const FAIL_LINES = 5;
const MAX_LINE = 200;

export type InstallTail = { ok: number; failed: number; fails: string[]; last: string[] };

/**
 * The real-install part of install-images.test.sh in an images job's log: the result lines after the install step's
 * command, so the compose-only run of the same script in the earlier "Shell script tests" step (which ends in "skip: real
 * install") is not counted. Null when the log holds no install step (it never started, or the log's shape changed).
 */
export function installTail(log: string): InstallTail | null {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  let start = -1;
  lines.forEach((l, i) => {
    if (INSTALL_COMMAND.test(l)) start = i;
  });
  if (start < 0) return null;
  const results = lines.slice(start + 1).filter((l) => RESULT_LINE.test(l));
  const cut = (l: string) => redactForModel(l.replace(/\s+/g, " ").slice(0, MAX_LINE));
  const fails = results.filter((l) => /^(?:FAIL\s|test-shell: FAILED)/.test(l));
  return { ok: results.filter((l) => l.startsWith("ok")).length, failed: fails.filter((l) => l.startsWith("FAIL")).length, fails: fails.slice(0, FAIL_LINES).map(cut), last: results.slice(-LAST_LINES).map(cut) };
}

/**
 * Which branch commit a run on bossman-ci/<ticket> tested, from GitHub CI before review's own rows (ci-preflight.ts):
 * the newest "started" row at or before the run was made, as long as that start had not already ended in a result before
 * it (a later run there is the merge gate's copy). Null when no before-review run explains it. Two minutes of slack on
 * the start: the server's clock and GitHub's may differ a little, and the push comes after the start row anyway.
 */
export function branchCommitFor(runCreatedAt: string, rows: ReadonlyArray<{ kind: string; sha: string | null; at: Date }>, kinds: { started: string; result: string }): string | null {
  const created = Date.parse(runCreatedAt);
  if (!Number.isFinite(created)) return null;
  const started = rows.filter((r) => r.kind === kinds.started && r.sha && r.at.getTime() <= created + 120_000).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (!started?.sha) return null;
  const ended = rows.some((r) => r.kind === kinds.result && r.sha === started.sha && r.at.getTime() >= started.at.getTime() && r.at.getTime() < created);
  return ended ? null : started.sha;
}

const stepWord = (c: string | null, status: string) => (status !== "completed" ? "running" : c === "success" ? "passed" : c === "failure" ? "FAILED" : (c ?? "unknown"));

/** One job's line: its result, the step it failed at, the install step, and the install test's own lines. */
export function jobLine(job: WorkflowJob, arch: string, tail: InstallTail | null | "unreadable"): string {
  const head = `- images (${arch})`;
  if (job.status === "completed" && job.conclusion === "skipped") return `${head}: skipped (GitHub ran no image jobs: the pushed commit changes no image files).`;
  const parts: string[] = [];
  if (job.status !== "completed") {
    const now = job.steps.find((s) => s.status === "in_progress");
    parts.push(`still running${now ? ` (at step "${now.name.slice(0, 80)}")` : ""}`);
  } else {
    const bad = job.steps.find((s) => s.conclusion === "failure" || s.conclusion === "timed_out" || s.conclusion === "cancelled");
    parts.push(job.conclusion === "success" ? "passed" : `${stepWord(job.conclusion, job.status)}${bad && !INSTALL_STEP.test(bad.name) ? ` at step "${bad.name.slice(0, 80)}"` : ""}`);
  }
  const install = job.steps.find((s) => INSTALL_STEP.test(s.name));
  parts.push(!install ? "install step: not in this job" : install.status === "queued" || (install.status === "completed" && install.conclusion === "skipped") ? "install step: not reached" : `install step: ${stepWord(install.conclusion, install.status)}`);
  if (tail === "unreadable") parts.push("install-images.test.sh lines: the job log couldn't be read (open the job page)");
  else if (tail) {
    parts.push(`install-images.test.sh: ${tail.ok} ok, ${tail.failed} FAIL`);
    if (tail.fails.length) parts.push(`failed: ${tail.fails.map((l) => `"${l}"`).join(" | ")}`);
    if (tail.last.length) parts.push(`last lines: ${tail.last.map((l) => `"${l}"`).join(" | ")}`);
  }
  return `${head}: ${parts.join("; ")}. ${job.url}`.trim();
}

/** Finished jobs' install lines: lost on restart, harmless because it only saves re-reading a finished job's log; bounded to the newest 50 jobs. */
const finishedTails = new Map<number, InstallTail | null>();

type Hosts = Pick<ReturnType<typeof gitHostService>, "workflowRuns" | "runJobs" | "jobLog">;

/**
 * The lines for `tickets read`: the newest CI run on the ticket's bossman-ci branch, each architecture's images job and
 * how far install-images.test.sh got. Null when there is nothing to show: not GitHub, no run there yet, or a run with no
 * images jobs. `branchCommit` names the ticket's own commit the run tested, when Boss Man's before-review rows say so.
 */
export async function imagesJobLines(hosts: Hosts, cfg: GitHostConfig, token: string, ticketId: string, branchCommit: (run: WorkflowRun) => Promise<string | null>): Promise<string[] | null> {
  if (cfg.kind !== "github") return null;
  let runs: WorkflowRun[];
  try {
    runs = await hosts.workflowRuns(cfg, token, `${CI_BRANCH_PREFIX}${ticketId}`, 10);
  } catch (err) {
    return err instanceof GitHostError ? [`GitHub images job: not available (${redactForModel(err.message).slice(0, 200)}).`] : null;
  }
  const run = runs.filter((r) => !r.path || r.path.endsWith("/ci.yml")).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!run) return null;
  let jobs: WorkflowJob[];
  try {
    jobs = await hosts.runJobs(cfg, token, run.id);
  } catch (err) {
    return err instanceof GitHostError ? [`GitHub images job: run ${run.url} found, but its jobs couldn't be read (${redactForModel(err.message).slice(0, 200)}).`] : null;
  }
  const images = jobs.flatMap((j) => {
    const m = IMAGES_JOB.exec(j.name);
    return m && !/^join\b/i.test(m[1]!) ? [{ job: j, arch: m[1]! }] : [];
  });
  if (!images.length) return null;
  const commit = await branchCommit(run).catch(() => null);
  const title = run.headMessage.split("\n")[0]!.slice(0, 80);
  const lines = [
    `GitHub images job (newest CI run on ${CI_BRANCH_PREFIX}${ticketId.slice(0, 8)}…, run ${run.id} attempt ${run.attempt}, ${run.status === "completed" ? `finished ${run.conclusion ?? ""}`.trim() : "still running"}, started ${run.createdAt.slice(0, 16).replace("T", " ")} UTC): it tested pushed commit ${run.headSha.slice(0, 8)}${title ? ` "${title}"` : ""}, ${commit ? `your branch commit ${commit.slice(0, 8)} merged with main` : "the merge gate's copy or an earlier before-review run (no before-review run of a branch commit matches it)"}. ${run.url}`,
  ];
  for (const { job, arch } of images) {
    const install = job.steps.find((s) => INSTALL_STEP.test(s.name));
    const ran = job.status === "completed" && !!install && install.status === "completed" && install.conclusion !== "skipped";
    let tail: InstallTail | null | "unreadable" = null;
    if (ran) {
      if (finishedTails.has(job.id)) tail = finishedTails.get(job.id) ?? null;
      else {
        try {
          tail = installTail(await hosts.jobLog(cfg, token, job.id));
          finishedTails.set(job.id, tail);
          if (finishedTails.size > 50) finishedTails.delete(finishedTails.keys().next().value as number);
        } catch {
          tail = "unreadable";
        }
      }
    }
    lines.push(jobLine(job, arch, tail));
  }
  return lines;
}
