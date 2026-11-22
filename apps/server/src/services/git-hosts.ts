// Pull requests on the project's git host (R59): Gitea or GitHub, through their REST APIs.
// Gitea's fields were checked against the v28.0.0 swagger (templates/swagger in the source):
// CreatePullRequestOption {title, head, base, body}; MergePullRequestOption {do, merge_title_field,
// merge_message_field, head_commit_id}; merge answers 200, or 405 (not allowed yet: approvals,
// status checks, permissions) and 409 (conflicts, head out of date) with a message.
import { strFromU8, unzipSync } from "fflate";
import { apiBaseFor, parseRepoUrl, redactForModel, type GitHostKind } from "@boss-man/shared";

export type GitHostConfig = { kind: GitHostKind; apiBase: string; owner: string; repo: string };
export type PullRequest = { number: number; url: string; merged: boolean; closed: boolean; mergeCommit: string | null };
/** What a commit's checks say (R86). GitHub's older commit statuses (not Actions check runs) aren't read. */
export type CommitChecks = { state: "passed" | "failed" | "pending" | "none"; failing: string[]; total?: number; /** A page for the run: the first failing one, else the first reported (BOS-1418). */ url?: string };
/**
 * A failed CI job on the host, with its page (BOS-1070). On GitHub `id` is the Actions job id, which is also its check run's
 * id (so its annotations can be asked for). `step`: the step that failed. `unstarted`: the job failed without running a
 * step or getting a runner, which is how GitHub's jobs data shows a job it refused to start (BOS-1630).
 */
export type CiRun = {
  id: number;
  name: string;
  url: string;
  step?: string;
  unstarted?: boolean;
  /** BOS-1733: the workflow run the job is in, for a re-run of its failed jobs. */
  runId?: number;
  /** BOS-2082: the workflow the run belongs to, and how long the failed step ran, for the slow-machine row. */
  workflowId?: number;
  stepSeconds?: number;
};
/**
 * What the merge gate reads before it merges (BOS-1070). `waiting`: jobs not finished yet. `billing`: a job didn't start
 * because of the account's spending limit or payments, which isn't the agent's to fix.
 */
export type CiStatus = { state: "passed" | "failed" | "pending" | "none" | "cancelled"; failed: CiRun[]; waiting: string[]; billing: boolean; cancelled?: CiRun[] };
const FAILED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "startup_failure", "action_required", "stale"];
const BILLING_TEXT = /spending limit|billing|account payments|payment (?:has )?failed/i;
/**
 * GitHub's own refusal to start a job: "The job was not started because recent account payments have failed or your
 * spending limit needs to be increased" (or "...your account is locked due to a billing issue"). Both parts must match, so
 * a failing test that merely mentions billing is still the agent's to fix, not an owner card.
 */
const billingRefusal = (text: string) => /\bjob was not started\b/i.test(text) && BILLING_TEXT.test(text);
/** BOS-2082: at most this many green runs' jobs are read for a step's usual time. */
const BASELINE_READS = 12;
/** BOS-2082: a test failure that ran out of time (vitest "Test timed out in 15000ms", Playwright "Timeout 30000ms exceeded"). */
const TIMEOUT_MESSAGE = /timed? ?out|timeout/i;
/** A summary annotation this long may have had its last entry cut by its writer's cap (ci.yml's web-browser job: 1500). */
const SUMMARY_CUT_AT = 1400;
/**
 * BOS-2082: whether one failure annotation's message says only timeouts. A job may write one summary annotation for all its
 * failures, entries joined by " | " (ci.yml's web-browser job: `file: test: first line`, at most 12, cut at 1500 characters,
 * with no file, so it names no test file): each entry must be a timeout on its own. Only a last entry of a message long
 * enough to have been cut may lack the word.
 */
export function allTimeouts(message: string): boolean {
  const parts = message.split(" | ").filter((p) => p.trim());
  if (!parts.length) return false;
  const cut = parts.length > 1 && message.length >= SUMMARY_CUT_AT;
  return parts.every((p, i) => TIMEOUT_MESSAGE.test(p) || (cut && i === parts.length - 1));
}
/**
 * BOS-2082: whether a job's own summary annotation (no file, or ".github": ci.yml's "web tests failed" and
 * annotate-vitest-failures.mjs's "runner tests failed", entries `file.test.ts: test: first line` joined by " | ") only repeats
 * failures that the job's file annotations already name. Each entry must start with a test file's base name that one of
 * `named` ends with; a note that names no file ("no JSON report was written"), or an entry cut before its name ends, is not
 * covered, so the job stays unnamed and the gate re-runs nothing. Without this every job that writes a summary was "unnamed"
 * (BOS-2119's flake, 21 Nov), whatever its file annotations said.
 */
export function summaryCovered(message: string, named: string[]): boolean {
  const entries = message.split(" | ").filter((p) => p.trim());
  if (!entries.length) return false;
  const bases = new Set(named.map((p) => p.split("/").pop()!));
  return entries.every((e) => {
    const m = /^([A-Za-z0-9_@.-]+\.(?:test|spec)\.[a-z]+): /.exec(e.trim());
    return !!m && bases.has(m[1]!);
  });
}
/** BOS-2082: GitHub's answer to a re-run of failed jobs; `why` is said on the ticket when it refused. */
export type RerunAnswer = { ok: true } | { ok: false; status?: number; why: string };
/** The refusal in plain words, with GitHub's own status and message (redacted, cut) so the cause is on record. */
export function rerunRefusal(status: number, message: string): string {
  const said = redactForModel(message).replace(/\s+/g, " ").slice(0, 200);
  if (status === 401 || status === 403 || /not accessible by|must have admin|permission/i.test(message))
    return `the git token can't re-run GitHub jobs (it needs Actions: Read and write); GitHub answered ${status}: ${said}`;
  return `GitHub refused to re-run the failed jobs (${status ? `HTTP ${status}` : "no answer"}: ${said})`;
}
/** Seconds between two GitHub timestamps, or null when either is missing or they make no sense. */
export function stepSeconds(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}
/** One GitHub Actions run on a branch (BOS-1072): enough to name the run and tell whether it failed. */
export type WorkflowRun = {
  id: number;
  attempt: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  headMessage: string;
  /** The workflow's file, e.g. .github/workflows/ci.yml (BOS-1688: a commit that changed it is a suspect). */
  path?: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};
/** `seconds` (BOS-2082): how long the step ran, from GitHub's started_at and completed_at; null while unknown. */
export type WorkflowStep = { number: number; name: string; status: string; conclusion: string | null; seconds?: number | null };
/** `runner`: the runner that took the job, null while none has (BOS-1630). */
export type WorkflowJob = { id: number; name: string; status: string; conclusion: string | null; url: string; runner?: string | null; steps: WorkflowStep[] };
/** The error annotations a failed check run published, grouped under the check's (the job's) name. */
export type CommitAnnotations = { name: string; lines: string[] };
export type MergeAttempt = { merged: true; commit: string | null } | { merged: false; note: string };
/** A pull request and the commits that made it: the host lists them in order, oldest first. */
export type PullRequestCommits = { pull: PullRequest; commits: string[] };
/** A compare between two commits (BOS-1688): its commits, oldest first, and every file the range changed (old names of renames too). */
export type CompareDetail = { commits: Array<{ sha: string; message: string; parents: string[] }>; files: string[] };

/** BOS-1749: every branch the merge gate pushes for CI starts with this (protocol.ts ciBranchFor); the only branches ever deleted. */
export const CI_BRANCH_PREFIX = "bossman-ci/";
export class GitHostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const MAX_LINES = 15;
export const MAX_LINE = 300;
const TAIL_LINES = 10;

const cleanLogLines = (log: string): string[] =>
  log
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/\u001b\[[0-9;]*m/g, "").replace(/^##\[(error|warning|group|endgroup)\]/, "$1: ").trim())
    .filter(Boolean);
const shorten = (l: string) => redactForModel(l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l);

/** The lines of a log that most likely say what went wrong: error-looking ones, timestamps and colour codes removed, secrets redacted. */
export function errorLines(log: string, max = MAX_LINES): string[] {
  const clean = cleanLogLines(log);
  const hits = clean.filter((l) => /(^error\b|\berror[: ]|\bfail(ed|ure|ing)?\b|✗|✕|×|assert|exception|\bFAIL\b|exit code|cannot find|not found|expected)/i.test(l));
  // The last ones are nearest the failure.
  return (hits.length ? hits : clean).slice(-max).map(shorten);
}

/** The error lines plus the last few lines of the log (redacted), for a ticket message. Tail lines already among the error lines are dropped. */
export function logExcerpt(log: string): { errors: string[]; tail: string[] } {
  const errors = errorLines(log);
  const tail = cleanLogLines(log).slice(-TAIL_LINES).map(shorten).filter((l) => !errors.includes(l));
  return { errors, tail };
}

/**
 * The one reader of a failed job's log, shared by the main-CI watcher and the merge gate's CI send-back (BOS-1667).
 * `lines` is never empty: the error lines, then the end of the log (secrets redacted), or one line saying why the
 * log can't be had. `readable` is true only when real log lines came back. `read` fetches the raw log.
 */
export async function readFailureLog(cfg: GitHostConfig, jobId: number, read: () => Promise<string>): Promise<{ lines: string[]; readable: boolean }> {
  if (cfg.kind !== "github") return { lines: ["(The job log isn't available from this git host; Boss Man can only read job logs on GitHub.)"], readable: false };
  if (!jobId) return { lines: ["(No job ran, so there is no job log.)"], readable: false };
  try {
    const { errors, tail } = logExcerpt(await read());
    if (!errors.length && !tail.length) return { lines: ["(The job log was empty.)"], readable: false };
    return { lines: [...errors, ...(tail.length ? ["… end of the log:", ...tail] : [])], readable: true };
  } catch (e) {
    const status = e instanceof GitHostError ? e.status : 0;
    const why =
      status === 401 || status === 403 ? "the git token isn't allowed to read job logs"
      : status === 404 || status === 410 ? "GitHub no longer has it (logs expire, or the job was deleted)"
      : status === 413 ? "it is too large to read"
      : `GitHub's answer couldn't be read (${(e instanceof Error ? e.message : String(e)).slice(0, 150)})`;
    return { lines: [`(The job log couldn't be read: ${why}. Open the job link above.)`], readable: false };
  }
}

const TIMEOUT_MS = 15_000;
/** BOS-1072: the most of a CI job log read (kept from the end), and the biggest download taken. */
export const MAX_LOG_CHARS = 4_000_000;
const MAX_LOG_DOWNLOAD = 32_000_000;

export function gitHostService(opts: { fetch?: typeof fetch } = {}) {
  const http = opts.fetch ?? fetch;

  const authHeaders = (cfg: GitHostConfig, token: string): Record<string, string> =>
    cfg.kind === "github"
      ? { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }
      : { authorization: `token ${token}`, accept: "application/json" };

  /** A GET with no token (BOS-1733): a public GitHub repo's annotations and runs need none. */
  const anonymousGet = (cfg: GitHostConfig, path: string) => call(cfg, null, "GET", path);

  async function call(cfg: GitHostConfig, token: string | null, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = token === null ? { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } : authHeaders(cfg, token);
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await http(`${cfg.apiBase}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json: json as Record<string, unknown> | Array<Record<string, unknown>> | null };
  }

  const messageOf = (json: unknown, status: number) => {
    const m = json && typeof json === "object" && "message" in json ? String((json as { message: unknown }).message) : "";
    return m || `HTTP ${status}`;
  };

  const toPull = (p: Record<string, unknown>): PullRequest => ({
    number: Number(p.number),
    url: String(p.html_url ?? ""),
    merged: p.merged === true || (typeof p.merged_at === "string" && !!p.merged_at),
    closed: p.state === "closed",
    mergeCommit: typeof p.merge_commit_sha === "string" && p.merge_commit_sha ? p.merge_commit_sha : null,
  });

  return {
    /** The host behind a repo address: GitHub by name, Gitea by asking /api/v1/version. */
    async detect(repoUrl: string): Promise<{ gitHost: GitHostKind; gitApiBase: string } | null> {
      const a = parseRepoUrl(repoUrl);
      if (!a) return null;
      if (a.kind === "github") return { gitHost: "github", gitApiBase: apiBaseFor("github", a.origin) };
      try {
        const res = await http(`${apiBaseFor("gitea", a.origin)}/version`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
        const v = res.ok ? ((await res.json()) as { version?: unknown }) : null;
        if (typeof v?.version === "string") return { gitHost: "gitea", gitApiBase: apiBaseFor("gitea", a.origin) };
      } catch {
        // Not reachable from here, or not Gitea: the owner can set it by hand.
      }
      return null;
    },

    /** The open pull request from head into base, opened if there isn't one. */
    async open(cfg: GitHostConfig, token: string, pr: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
      if (cfg.kind === "gitea") {
        const found = await call(cfg, token, "GET", `/pulls/${encodeURIComponent(pr.base)}/${pr.head.split("/").map(encodeURIComponent).join("/")}`);
        if (found.ok && found.json && !Array.isArray(found.json) && found.json.state === "open") return toPull(found.json);
      } else {
        const found = await call(cfg, token, "GET", `/pulls?state=open&head=${encodeURIComponent(`${cfg.owner}:${pr.head}`)}&base=${encodeURIComponent(pr.base)}`);
        if (found.ok && Array.isArray(found.json) && found.json[0]) return toPull(found.json[0]);
      }
      const made = await call(cfg, token, "POST", "/pulls", { title: pr.title, head: pr.head, base: pr.base, body: pr.body });
      if (!made.ok || !made.json || Array.isArray(made.json)) throw new GitHostError(made.status, `The host didn't open the pull request: ${messageOf(made.json, made.status)}`);
      return toPull(made.json);
    },

    /** Merges it if the host allows; otherwise says why not (approvals, checks, conflicts). */
    async merge(cfg: GitHostConfig, token: string, number: number, m: { headSha: string | null; title: string; message: string }): Promise<MergeAttempt> {
      const res =
        cfg.kind === "gitea"
          ? await call(cfg, token, "POST", `/pulls/${number}/merge`, { do: "merge", merge_title_field: m.title, merge_message_field: m.message, ...(m.headSha ? { head_commit_id: m.headSha } : {}) })
          : await call(cfg, token, "PUT", `/pulls/${number}/merge`, { merge_method: "merge", commit_title: m.title, commit_message: m.message, ...(m.headSha ? { sha: m.headSha } : {}) });
      if (res.ok) {
        const sha = res.json && !Array.isArray(res.json) && typeof res.json.sha === "string" ? res.json.sha : null;
        // Gitea answers 200 with no body; the merge commit is on the pull request.
        return { merged: true, commit: sha ?? (await this.get(cfg, token, number).then((p) => p.mergeCommit, () => null)) };
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) throw new GitHostError(res.status, `The host refused: ${messageOf(res.json, res.status)}`);
      return { merged: false, note: messageOf(res.json, res.status) };
    },

    /**
     * Whether a token can reach the repo and push to it (R58, R56): one read of the repo, whose
     * answer carries the token's permissions on both hosts. Gitea needs the write:repository scope.
     */
    async checkAccess(cfg: GitHostConfig, token: string): Promise<{ ok: boolean; canPush: boolean; canReadChecks?: boolean; message: string }> {
      const res = await call(cfg, token, "GET", "");
      if (res.status === 401 || res.status === 403) return { ok: false, canPush: false, message: `The host refused the token (HTTP ${res.status}).` };
      if (res.status === 404) return { ok: false, canPush: false, message: "The token can't see the repo: check its owner and name, and that the token has access to it." };
      if (!res.ok || !res.json || Array.isArray(res.json)) return { ok: false, canPush: false, message: `The host answered ${res.status}.` };
      const perms = (res.json.permissions ?? {}) as { push?: boolean; admin?: boolean };
      const canPush = perms.push === true || perms.admin === true;
      const message = canPush ? "The token can read and push to the repo." : "The token can read the repo but not push to it, so merges and pull requests would fail.";
      // GitHub: can the merge gate read CI results (BOS-1070)? It reads them through Actions (BOS-1630), so a fine-grained
      // token needs Actions: Read-only (Metadata comes with every token). `canReadChecks` keeps its name for the web page.
      if (cfg.kind !== "github") return { ok: true, canPush, message };
      const probe = await call(cfg, token, "GET", "/actions/runs?per_page=1").catch(() => null);
      const canReadChecks = !!probe?.ok;
      return { ok: true, canPush, canReadChecks, message: `${message} ${canReadChecks ? "It can read GitHub Actions runs." : `It can't read GitHub Actions runs${probe ? ` (HTTP ${probe.status})` : ""}, so the merge gate can't wait for CI: give it Repository permissions → Actions: Read-only (and Metadata: Read-only).`}` };
    },

    /**
     * Whether CI on a commit is finished and green, for the merge gate (BOS-1070). Read through the Actions API (BOS-1630),
     * which a fine-grained token with Actions: Read-only can use; the Checks API needs a permission the owner's token type
     * doesn't offer. A workflow run stays in progress until its last job ends, so "pending" also covers jobs not begun yet.
     * Only the newest run of each workflow and event counts, as a re-push or re-run replaces the older one. A failed run's
     * jobs are read for the names and pages of the failing ones. Elsewhere (Gitea) it is the commit statuses, as checks() reads them.
     */
    async ciStatus(cfg: GitHostConfig, token: string, sha: string): Promise<CiStatus> {
      if (cfg.kind !== "github") {
        const c = await this.checks(cfg, token, sha);
        return { state: c.state, failed: c.failing.map((name) => ({ id: 0, name, url: "" })), waiting: [], billing: false };
      }
      const res = await call(cfg, token, "GET", `/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`);
      const all = (res.json && !Array.isArray(res.json) ? res.json.workflow_runs : null) as Array<Record<string, unknown>> | null;
      if (!res.ok || !Array.isArray(all)) throw new GitHostError(res.status, `Couldn't read the Actions runs on ${sha.slice(0, 8)}: ${messageOf(res.json, res.status)}`);
      const newest = new Map<string, Record<string, unknown>>();
      for (const r of all) {
        if (r.head_sha !== undefined && r.head_sha !== sha) continue;
        const key = `${String(r.workflow_id ?? r.name)}:${String(r.event ?? "")}`;
        const had = newest.get(key);
        if (!had || String(r.created_at ?? "") > String(had.created_at ?? "")) newest.set(key, r);
      }
      const runs = [...newest.values()];
      const nameOf = (r: Record<string, unknown>) => String(r.name ?? r.display_title ?? "CI");
      const waiting = runs.filter((r) => r.status !== "completed").map(nameOf);
      const failed: CiRun[] = [];
      const cancelled: CiRun[] = [];
      for (const r of runs.filter((x) => x.status === "completed" && FAILED_CONCLUSIONS.includes(String(x.conclusion)))) {
        const jobs = await this.runJobs(cfg, token, Number(r.id));
        const bad = jobs.filter((j) => FAILED_CONCLUSIONS.includes(String(j.conclusion)));
        // A run GitHub cancelled (a newer run replaced it, or someone stopped it) tested nothing: it's no failure unless a
        // job in it really failed. The gate decides what a cancelled run means (it knows the branch's other runs).
        if (r.conclusion === "cancelled" && !bad.some((j) => j.conclusion !== "cancelled")) {
          cancelled.push({ id: Number(r.id), name: nameOf(r), url: String(r.html_url ?? "") });
          continue;
        }
        // A run that failed before any job (a broken workflow file) is named by the run itself.
        if (!bad.length) failed.push({ id: 0, name: nameOf(r), url: String(r.html_url ?? ""), runId: Number(r.id) });
        for (const j of bad) {
          const step = j.steps.find((s) => FAILED_CONCLUSIONS.includes(String(s.conclusion)));
          const workflowId = Number(r.workflow_id);
          failed.push({
            id: j.id,
            name: j.name,
            url: j.url,
            runId: Number(r.id),
            ...(step ? { step: step.name } : {}),
            ...(typeof step?.seconds === "number" ? { stepSeconds: step.seconds } : {}),
            ...(Number.isFinite(workflowId) && workflowId > 0 ? { workflowId } : {}),
            ...(j.conclusion === "failure" && !j.steps.length && !j.runner ? { unstarted: true } : {}),
          });
        }
      }
      const state = failed.length ? "failed" : !runs.length ? "none" : waiting.length ? "pending" : cancelled.length ? "cancelled" : "passed";
      return { state, failed, waiting, billing: false, ...(cancelled.length ? { cancelled } : {}) };
    },

    /** Ask GitHub to run a workflow run again (needs Actions: Write). False when it refuses, which the caller reports plainly. */
    async rerunRun(cfg: GitHostConfig, token: string, runId: number): Promise<boolean> {
      if (cfg.kind !== "github") return false;
      const res = await call(cfg, token, "POST", `/actions/runs/${runId}/rerun`).catch(() => null);
      return !!res?.ok;
    },

    /**
     * BOS-1749: the merge gate's CI branches (bossman-ci/*) on the host with the time of the commit each points at, newest
     * first. GitHub only: other hosts get an empty list. Reads at most 5 pages of 100 refs.
     */
    async ciBranches(cfg: GitHostConfig, token: string): Promise<Array<{ branch: string; sha: string; committedAt: number }>> {
      if (cfg.kind !== "github") return [];
      const refs: Array<{ branch: string; sha: string }> = [];
      for (let page = 1; page <= 5; page++) {
        const res = await call(cfg, token, "GET", `/git/matching-refs/heads/${CI_BRANCH_PREFIX}?per_page=100&page=${page}`);
        if (!res.ok || !Array.isArray(res.json)) throw new GitHostError(res.status, `Couldn't list ${CI_BRANCH_PREFIX} branches: ${messageOf(res.json, res.status)}`);
        for (const r of res.json) {
          const name = typeof r.ref === "string" ? r.ref.replace(/^refs\/heads\//, "") : "";
          const sha = (r.object as { sha?: unknown } | undefined)?.sha;
          if (name.startsWith(CI_BRANCH_PREFIX) && typeof sha === "string") refs.push({ branch: name, sha });
        }
        if (res.json.length < 100) break;
      }
      const out: Array<{ branch: string; sha: string; committedAt: number }> = [];
      for (const r of refs) {
        const c = await call(cfg, token, "GET", `/git/commits/${encodeURIComponent(r.sha)}`);
        const when = c.ok && c.json && !Array.isArray(c.json) ? Date.parse(String((c.json.committer as { date?: unknown } | undefined)?.date ?? "")) : NaN;
        // Unreadable commit: treated as old (0), so a branch whose commit can't be read is still cleared.
        out.push({ ...r, committedAt: Number.isFinite(when) ? when : 0 });
      }
      return out.sort((a, b) => b.committedAt - a.committedAt);
    },

    /** BOS-1749: deletes one CI branch. Refuses any name outside bossman-ci/ so no other branch can ever be touched. Already gone counts as deleted. */
    async deleteCiBranch(cfg: GitHostConfig, token: string, branch: string): Promise<boolean> {
      if (cfg.kind !== "github" || !branch.startsWith(CI_BRANCH_PREFIX) || branch.includes("..") || branch.length <= CI_BRANCH_PREFIX.length) return false;
      const res = await call(cfg, token, "DELETE", `/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
      return res.ok || res.status === 404 || res.status === 422;
    },

    /**
     * What failed in failed CI jobs (BOS-1070): vitest's GitHub reporter writes an annotation per failing test, with its name,
     * so the agent is told what failed. Up to `per` lines per job; the generic "Process completed with exit code" goes.
     * Annotations sit behind the Checks permission, so they are optional (BOS-1630): a refused read gives the failed step
     * instead, and a job GitHub never started is taken as its billing refusal, the one reason that leaves no step and no runner.
     */
    async failures(cfg: GitHostConfig, token: string, runs: CiRun[], per = 10): Promise<Array<{ run: CiRun; lines: string[]; billing: boolean; paths: string[] | null; timeoutsOnly?: boolean }>> {
      if (cfg.kind !== "github") return [];
      const out: Array<{ run: CiRun; lines: string[]; billing: boolean; paths: string[] | null; timeoutsOnly?: boolean }> = [];
      for (const run of runs.slice(0, 5)) {
        let res = run.id ? await call(cfg, token, "GET", `/check-runs/${run.id}/annotations?per_page=50`).catch(() => null) : null;
        // BOS-1733: a fine-grained token has no Checks permission (BOS-1630), but a public repo's annotations need no token at
        // all, so a refused read is asked once more without it. A private repo answers that with 404, as before.
        if (run.id && (res?.status === 401 || res?.status === 403)) res = await anonymousGet(cfg, `/check-runs/${run.id}/annotations?per_page=50`).catch(() => null);
        if (!res?.ok || !Array.isArray(res.json)) {
          out.push({ run, lines: run.step ? [`failed at step "${run.step}"`] : [], billing: !!run.unstarted, paths: null });
          continue;
        }
        const rows = res.json;
        const failing = rows.filter((a) => a.annotation_level === "failure");
        // The files the failures point at (BOS-1733), without GitHub's own job-level line (".github", "Process completed").
        const fileOf = (a: Record<string, unknown>) => (typeof a.path === "string" && a.path && a.path !== ".github" ? a.path : "");
        const own = failing.filter((a) => !/^Process completed with exit code/i.test(String(a.message ?? "")));
        const onFiles = own.map(fileOf).filter(Boolean);
        // BOS-2082: the job's own summary note is left out of the naming when its file notes already name every entry in it.
        const paths = own.filter((a) => fileOf(a) || !summaryCovered(String(a.message ?? ""), onFiles)).map(fileOf);
        // Only GitHub's account-level note counts (no file, or ".github"): a test's annotation always names its file.
        const billing = failing.some((a) => (!a.path || a.path === ".github") && billingRefusal(`${String(a.title ?? "")} ${String(a.message ?? "")}`)) || (!failing.length && !!run.unstarted);
        const lines = failing
          .filter((a) => !/^Process completed with exit code/i.test(String(a.message ?? "")))
          .map((a) => {
            const where = typeof a.path === "string" && a.path && a.path !== ".github" ? `${a.path}${a.start_line ? `:${a.start_line}` : ""}: ` : "";
            const title = typeof a.title === "string" && a.title ? `${a.title}: ` : "";
            return `${where}${title}${String(a.message ?? "").split("\n")[0]}`.slice(0, 300);
          })
          .slice(0, per);
        // BOS-2082: every test failure ran out of time (judged on the message, not the test's title, which may say "timeout").
        const tests = failing.filter((a) => !/^Process completed with exit code/i.test(String(a.message ?? "")));
        const timeoutsOnly = tests.length > 0 && tests.every((a) => allTimeouts(String(a.message ?? "")));
        out.push({ run, lines, billing, paths, timeoutsOnly });
      }
      return out;
    },

    /**
     * BOS-1733: ask GitHub to run only the failed jobs of a workflow run again (needs Actions: Read and write). Not ok when it
     * refuses or off GitHub; the gate then sends the ticket back as before and says why. BOS-2082: `why` carries GitHub's own
     * answer (status and message), so a refusal says whether it was the token's permission or something else: on 21 Nov the
     * gate only said "can't", and nobody could tell which.
     */
    async rerunFailedJobs(cfg: GitHostConfig, token: string, runId: number): Promise<RerunAnswer> {
      if (cfg.kind !== "github") return { ok: false, why: "only GitHub can re-run failed jobs" };
      if (!runId) return { ok: false, why: "GitHub named no workflow run to re-run" };
      const res = await call(cfg, token, "POST", `/actions/runs/${runId}/rerun-failed-jobs`).catch((e: unknown) => ({ status: 0, ok: false, json: { message: String((e as Error)?.message ?? e) } }));
      if (res.ok) return { ok: true };
      return { ok: false, status: res.status, why: rerunRefusal(res.status, messageOf(res.json, res.status)) };
    },

    /**
     * The checks on a commit: GitHub check runs, or Gitea's commit statuses. A GitHub token refused the Checks API (a
     * fine-grained token with Actions: Read-only only, BOS-1630) gets the commit's Actions runs instead, one row per workflow.
     */
    async checks(cfg: GitHostConfig, token: string, sha: string): Promise<CommitChecks> {
      const gh = cfg.kind === "github";
      const res = await call(cfg, token, "GET", gh ? `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100` : `/commits/${encodeURIComponent(sha)}/status`);
      if (gh && (res.status === 401 || res.status === 403)) {
        const a = await call(cfg, token, "GET", `/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`);
        const runs = (a.json && !Array.isArray(a.json) ? a.json.workflow_runs : null) as Array<Record<string, unknown>> | null;
        if (!a.ok || !Array.isArray(runs)) throw new GitHostError(a.status, `Couldn't read the Actions runs on ${sha.slice(0, 8)}: ${messageOf(a.json, a.status)}`);
        const bad = runs.filter((r) => r.status === "completed" && FAILED_CONCLUSIONS.includes(String(r.conclusion)));
        const link = [...bad, ...runs].map((r) => r.html_url).find((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
        const pending = runs.some((r) => r.status !== "completed");
        return { state: bad.length ? "failed" : !runs.length ? "none" : pending ? "pending" : "passed", failing: bad.map((r) => String(r.name ?? "CI")), total: runs.length, ...(link ? { url: link } : {}) };
      }
      const body = res.json && !Array.isArray(res.json) ? res.json : null;
      const rows = ((gh ? body?.check_runs : body?.statuses) ?? null) as Array<Record<string, unknown>> | null;
      if (!res.ok || !Array.isArray(rows)) throw new GitHostError(res.status, `Couldn't read the checks on ${sha.slice(0, 8)}: ${messageOf(res.json, res.status)}`);
      const failingRows = rows.filter((r) => (gh ? ["failure", "timed_out", "cancelled", "startup_failure"].includes(String(r.conclusion)) : ["failure", "error"].includes(String(r.status))));
      const failing = failingRows.map((r) => String(gh ? r.name : r.context));
      const waiting = rows.some((r) => (gh ? r.status !== "completed" : r.status === "pending"));
      const link = [...failingRows, ...rows].map((r) => (gh ? r.html_url : r.target_url)).find((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
      return { state: failing.length ? "failed" : !rows.length ? "none" : waiting ? "pending" : "passed", failing, total: rows.length, ...(link ? { url: link } : {}) };
    },

    /**
     * The most recent Actions runs on a branch (BOS-1072), newest first: pushes to main and the
     * nightly schedule alike. GitHub only: returns [] elsewhere, so a watcher can say plainly that
     * there is nothing to read.
     */
    async workflowRuns(cfg: GitHostConfig, token: string, branch: string, limit = 30): Promise<WorkflowRun[]> {
      if (cfg.kind !== "github") return [];
      const res = await call(cfg, token, "GET", `/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${Math.max(1, Math.min(100, limit))}`);
      const body = res.json && !Array.isArray(res.json) ? res.json : null;
      const rows = body?.workflow_runs as Array<Record<string, unknown>> | undefined;
      if (!res.ok || !Array.isArray(rows)) throw new GitHostError(res.status, `Couldn't read the workflow runs on ${branch}: ${messageOf(res.json, res.status)}`);
      return rows.map((r) => {
        const head = (r.head_commit ?? {}) as Record<string, unknown>;
        return {
          id: Number(r.id),
          attempt: Number(r.run_attempt ?? 1),
          name: String(r.name ?? r.workflow_name ?? "CI"),
          event: String(r.event ?? ""),
          status: String(r.status ?? ""),
          conclusion: typeof r.conclusion === "string" ? r.conclusion : null,
          headSha: String(r.head_sha ?? ""),
          headMessage: typeof head.message === "string" ? head.message : "",
          ...(typeof r.path === "string" && r.path ? { path: r.path.split("@")[0]! } : {}),
          url: String(r.html_url ?? ""),
          createdAt: String(r.created_at ?? ""),
          updatedAt: String(r.updated_at ?? r.created_at ?? ""),
        };
      });
    },

    /** The jobs and their steps in one Actions run, so a failure can name the job and step. */
    async runJobs(cfg: GitHostConfig, token: string, runId: number): Promise<WorkflowJob[]> {
      if (cfg.kind !== "github") return [];
      const res = await call(cfg, token, "GET", `/actions/runs/${runId}/jobs?per_page=100`);
      const body = res.json && !Array.isArray(res.json) ? res.json : null;
      const rows = body?.jobs as Array<Record<string, unknown>> | undefined;
      if (!res.ok || !Array.isArray(rows)) throw new GitHostError(res.status, `Couldn't read the jobs of run ${runId}: ${messageOf(res.json, res.status)}`);
      return rows.map((j) => ({
        id: Number(j.id),
        name: String(j.name ?? "job"),
        status: String(j.status ?? ""),
        conclusion: typeof j.conclusion === "string" ? j.conclusion : null,
        url: String(j.html_url ?? ""),
        runner: typeof j.runner_name === "string" && j.runner_name ? j.runner_name : null,
        steps: (Array.isArray(j.steps) ? (j.steps as Array<Record<string, unknown>>) : []).map((s) => ({
          number: Number(s.number ?? 0),
          name: String(s.name ?? "step"),
          status: String(s.status ?? ""),
          conclusion: typeof s.conclusion === "string" ? s.conclusion : null,
          seconds: stepSeconds(s.started_at, s.completed_at),
        })),
      }));
    },

    /**
     * BOS-2082: how long one job's step usually runs: its times in up to `want` recent green runs of the same workflow (the
     * merge gate's CI branches and main alike), newest first, skipping run `exceptRunId`. Reads at most BASELINE_READS runs'
     * jobs. GitHub only; [] elsewhere or when nothing can be read, which the slow-machine row reads as "no baseline".
     */
    async stepTimes(cfg: GitHostConfig, token: string, q: { workflowId: number; job: string; step: string; exceptRunId?: number; want: number }): Promise<number[]> {
      if (cfg.kind !== "github") return [];
      const res = await call(cfg, token, "GET", `/actions/workflows/${q.workflowId}/runs?status=success&per_page=20`);
      const rows = (res.json && !Array.isArray(res.json) ? res.json.workflow_runs : null) as Array<Record<string, unknown>> | null;
      if (!res.ok || !Array.isArray(rows)) return [];
      const out: number[] = [];
      for (const r of rows.filter((x) => Number(x.id) !== q.exceptRunId).slice(0, BASELINE_READS)) {
        if (out.length >= q.want) break;
        const jobs = await this.runJobs(cfg, token, Number(r.id)).catch(() => [] as WorkflowJob[]);
        const s = jobs.find((j) => j.name === q.job && j.conclusion === "success")?.steps.find((x) => x.name === q.step && x.conclusion === "success");
        if (typeof s?.seconds === "number") out.push(s.seconds);
      }
      return out;
    },

    /**
     * One job's log text (BOS-1072). GitHub answers with a zip of step logs; the chunks are joined
     * oldest first. A plain body is returned as it is, so a proxy or a test can answer either way.
     */
    async jobLog(cfg: GitHostConfig, token: string, jobId: number): Promise<string> {
      if (cfg.kind !== "github") return "";
      const res = await http(`${cfg.apiBase}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/actions/jobs/${jobId}/logs`, {
        headers: authHeaders(cfg, token),
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new GitHostError(res.status, `Couldn't read the log of job ${jobId}: HTTP ${res.status}`);
      // A log can be huge: refuse a big download outright and keep only the end of the text, where the error is.
      if (Number(res.headers.get("content-length") ?? 0) > MAX_LOG_DOWNLOAD) throw new GitHostError(413, `The log of job ${jobId} is too large to read`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_LOG_DOWNLOAD) throw new GitHostError(413, `The log of job ${jobId} is too large to read`);
      let text: string;
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        // Skip any one step log that would unpack to more than the cap; the rest still say what failed.
        const files = unzipSync(bytes, { filter: (f) => f.originalSize <= MAX_LOG_CHARS });
        text = Object.keys(files)
          .sort()
          .map((name) => strFromU8(files[name]!))
          .join("\n");
      } else {
        text = new TextDecoder().decode(bytes);
      }
      return text.length > MAX_LOG_CHARS ? text.slice(-MAX_LOG_CHARS) : text;
    },

    /**
     * What a failed job's log says, as lines for a ticket message (BOS-1667): its error lines, then the end of the log,
     * secrets redacted. Never empty and never throws: when the log can't be had the one line says why.
     */
    async jobLogBlock(cfg: GitHostConfig, token: string, jobId: number): Promise<string[]> {
      return readFailureLog(cfg, jobId, () => this.jobLog(cfg, token, jobId)).then((r) => r.lines);
    },

    /**
     * The failure annotations on a commit's check runs (BOS-1072), grouped by the check's name (the
     * job's name in Actions). Used when the log is unreadable, so a ticket still carries error lines.
     */
    async commitAnnotations(cfg: GitHostConfig, token: string, sha: string): Promise<CommitAnnotations[]> {
      if (cfg.kind !== "github") return [];
      const res = await call(cfg, token, "GET", `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`);
      const body = res.json && !Array.isArray(res.json) ? res.json : null;
      const rows = body?.check_runs as Array<Record<string, unknown>> | undefined;
      if (!res.ok || !Array.isArray(rows)) return [];
      const out: CommitAnnotations[] = [];
      for (const row of rows) {
        if (!["failure", "timed_out", "cancelled", "startup_failure"].includes(String(row.conclusion))) continue;
        const id = Number(row.id);
        if (!id) continue;
        const a = await call(cfg, token, "GET", `/check-runs/${id}/annotations?per_page=100`);
        const list = Array.isArray(a.json) ? a.json : [];
        const lines = list.flatMap((n) => {
          if (!n || typeof n !== "object") return [];
          const x = n as Record<string, unknown>;
          const where = x.path ? `${String(x.path)}${x.start_line ? `:${String(x.start_line)}` : ""} ` : "";
          const title = x.title ? `${String(x.title)}: ` : "";
          const message = String(x.message ?? "").trim();
          const raw = typeof x.raw_details === "string" ? x.raw_details.trim().split(/\r?\n/).slice(0, 5) : [];
          return [`${where}${title}${message}`.trim(), ...raw].filter(Boolean);
        });
        if (lines.length) out.push({ name: String(row.name ?? "check"), lines });
      }
      return out;
    },

    /** The commit a branch points at: GitHub calls it commit.sha, Gitea commit.id. */
    async branchHead(cfg: GitHostConfig, token: string, branch: string): Promise<string> {
      const res = await call(cfg, token, "GET", `/branches/${branch.split("/").map(encodeURIComponent).join("/")}`);
      const c = res.json && !Array.isArray(res.json) ? (res.json.commit as Record<string, unknown> | undefined) : undefined;
      const sha = c?.sha ?? c?.id;
      if (!res.ok || typeof sha !== "string" || !sha) throw new GitHostError(res.status, `Couldn't read branch ${branch}: ${messageOf(res.json, res.status)}`);
      return sha;
    },

    /**
     * A pull request with its commits, oldest first (BOS-130). With a headSha, the commits are
     * read only up to that one, so a branch pushed to since still answers for the reviewed work.
     */
    async getWithCommits(cfg: GitHostConfig, token: string, number: number, headSha: string | null): Promise<PullRequestCommits> {
      const pull = await this.get(cfg, token, number);
      // The host pages at 100: read up to ten pages, stopping as soon as the reviewed head is in.
      const commits: string[] = [];
      for (let page = 0; page < 10; page++) {
        const res = await call(cfg, token, "GET", `/pulls/${number}/commits?per_page=100&page=${page + 1}`);
        if (!res.ok || !Array.isArray(res.json)) throw new GitHostError(res.status, `Couldn't read the commits of pull request ${number}: ${messageOf(res.json, res.status)}`);
        for (const c of res.json) {
          const sha = typeof c.sha === "string" ? c.sha.slice(0, 40) : null;
          if (sha) commits.push(sha);
          if (headSha && c.sha === headSha) return { pull, commits };
        }
        if (res.json.length < 100) break;
      }
      return { pull, commits };
    },

    /** The commits one commit adds over another (oldest first), from the host's compare (BOS-130). */
    async compare(cfg: GitHostConfig, token: string, from: string, to: string): Promise<string[]> {
      const res = await call(cfg, token, "GET", `/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}?per_page=250`);
      if (!res.ok || !res.json || Array.isArray(res.json)) throw new GitHostError(res.status, `Couldn't compare ${from.slice(0, 8)} with ${to.slice(0, 8)}: ${messageOf(res.json, res.status)}`);
      // GitHub's compare: commits[].sha. Gitea's own compare endpoint isn't in its REST API, so
      // this only answers for GitHub; elsewhere it fails and the check is left to the runner.
      const rows = Array.isArray(res.json.commits) ? (res.json.commits as Array<Record<string, unknown>>) : [];
      return rows.map((c) => (typeof c.sha === "string" ? c.sha.slice(0, 40) : "")).filter(Boolean);
    },

    /**
     * GitHub's compare with what the main-CI watcher needs to rank suspects (BOS-1688): every commit
     * from..to with its parents and first message line, and the files the whole range changed. Needs
     * the token's Contents read; with Actions read only it throws and the caller says so.
     */
    async compareDetail(cfg: GitHostConfig, token: string, from: string, to: string): Promise<CompareDetail> {
      const res = await call(cfg, token, "GET", `/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}?per_page=250`);
      if (!res.ok || !res.json || Array.isArray(res.json)) throw new GitHostError(res.status, `Couldn't compare ${from.slice(0, 8)} with ${to.slice(0, 8)}: ${messageOf(res.json, res.status)}`);
      const rows = Array.isArray(res.json.commits) ? (res.json.commits as Array<Record<string, unknown>>) : [];
      const files = Array.isArray(res.json.files) ? (res.json.files as Array<Record<string, unknown>>) : [];
      return {
        commits: rows
          .filter((c) => typeof c.sha === "string" && c.sha)
          .map((c) => {
            const commit = (c.commit ?? {}) as Record<string, unknown>;
            const parents = Array.isArray(c.parents) ? (c.parents as Array<Record<string, unknown>>) : [];
            return {
              sha: String(c.sha),
              message: typeof commit.message === "string" ? commit.message.split("\n")[0]! : "",
              parents: parents.map((p) => String(p.sha ?? "")).filter(Boolean),
            };
          }),
        files: files.flatMap((f) => [f.filename, f.previous_filename]).filter((n): n is string => typeof n === "string" && !!n),
      };
    },

    /**
     * Every file path in the tree at `sha` (R40, BOS-1685): the main-CI watcher resolves a package-relative file a
     * failure names (`test/a.test.ts`) to its repo path. Throws when it can't be read or GitHub cut the list short,
     * so the caller treats the red's scope as unknown rather than guessing from part of the tree.
     */
    async treePaths(cfg: GitHostConfig, token: string, sha: string): Promise<string[]> {
      const res = await call(cfg, token, "GET", `/git/trees/${encodeURIComponent(sha)}?recursive=1`);
      if (!res.ok || !res.json || Array.isArray(res.json)) throw new GitHostError(res.status, `Couldn't read the tree at ${sha.slice(0, 8)}: ${messageOf(res.json, res.status)}`);
      if (res.json.truncated === true) throw new GitHostError(res.status, `GitHub cut the tree at ${sha.slice(0, 8)} short`);
      const rows = Array.isArray(res.json.tree) ? (res.json.tree as Array<Record<string, unknown>>) : [];
      return rows.filter((r) => r.type === "blob" && typeof r.path === "string").map((r) => String(r.path));
    },

    async get(cfg: GitHostConfig, token: string, number: number): Promise<PullRequest> {
      const res = await call(cfg, token, "GET", `/pulls/${number}`);
      if (!res.ok || !res.json || Array.isArray(res.json)) throw new GitHostError(res.status, `Couldn't read pull request ${number}: ${messageOf(res.json, res.status)}`);
      return toPull(res.json);
    },
  };
}
