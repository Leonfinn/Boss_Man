// Pull requests on the project's git host (R59): Gitea or GitHub, through their REST APIs.
// Gitea's fields were checked against the v28.0.0 swagger (templates/swagger in the source):
// CreatePullRequestOption {title, head, base, body}; MergePullRequestOption {do, merge_title_field,
// merge_message_field, head_commit_id}; merge answers 200, or 405 (not allowed yet: approvals,
// status checks, permissions) and 409 (conflicts, head out of date) with a message.
import { strFromU8, unzipSync } from "fflate";
import { apiBaseFor, parseRepoUrl, type GitHostKind } from "@boss-man/shared";

export type GitHostConfig = { kind: GitHostKind; apiBase: string; owner: string; repo: string };
export type PullRequest = { number: number; url: string; merged: boolean; closed: boolean; mergeCommit: string | null };
/** What a commit's checks say (R86). GitHub's older commit statuses (not Actions check runs) aren't read. */
export type CommitChecks = { state: "passed" | "failed" | "pending" | "none"; failing: string[]; total?: number; /** A page for the run: the first failing one, else the first reported (BOS-1418). */ url?: string };
/** A failed CI job on the host, with its page (BOS-1070). */
export type CiRun = { id: number; name: string; url: string };
/**
 * What the merge gate reads before it merges (BOS-1070). `waiting`: jobs not finished yet. `billing`: a job didn't start
 * because of the account's spending limit or payments, which isn't the agent's to fix.
 */
export type CiStatus = { state: "passed" | "failed" | "pending" | "none"; failed: CiRun[]; waiting: string[]; billing: boolean };
const FAILED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "startup_failure", "action_required", "stale"];
const BILLING_TEXT = /spending limit|billing|account payments|payment (?:has )?failed/i;
/**
 * GitHub's own refusal to start a job: "The job was not started because recent account payments have failed or your
 * spending limit needs to be increased" (or "...your account is locked due to a billing issue"). Both parts must match, so
 * a failing test that merely mentions billing is still the agent's to fix, not an owner card.
 */
const billingRefusal = (text: string) => /\bjob was not started\b/i.test(text) && BILLING_TEXT.test(text);
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
  url: string;
  createdAt: string;
  updatedAt: string;
};
export type WorkflowStep = { number: number; name: string; status: string; conclusion: string | null };
export type WorkflowJob = { id: number; name: string; status: string; conclusion: string | null; url: string; steps: WorkflowStep[] };
/** The error annotations a failed check run published, grouped under the check's (the job's) name. */
export type CommitAnnotations = { name: string; lines: string[] };
export type MergeAttempt = { merged: true; commit: string | null } | { merged: false; note: string };
/** A pull request and the commits that made it: the host lists them in order, oldest first. */
export type PullRequestCommits = { pull: PullRequest; commits: string[] };

export class GitHostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
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

  async function call(cfg: GitHostConfig, token: string, method: string, path: string, body?: unknown) {
    const headers = authHeaders(cfg, token);
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
      // GitHub: can the merge gate read CI results (BOS-1070)? A fine-grained token needs Checks: Read-only.
      const branch = typeof res.json.default_branch === "string" ? res.json.default_branch : null;
      if (cfg.kind !== "github" || !branch) return { ok: true, canPush, message };
      const probe = await call(cfg, token, "GET", `/commits/${encodeURIComponent(branch)}/check-runs?per_page=1`).catch(() => null);
      const canReadChecks = !!probe?.ok;
      return { ok: true, canPush, canReadChecks, message: `${message} ${canReadChecks ? "It can read GitHub checks." : `It can't read GitHub checks${probe ? ` (HTTP ${probe.status})` : ""}, so the merge gate can't wait for CI: give it Repository permissions → Checks: Read-only.`}` };
    },

    /**
     * Whether CI on a commit is finished and green, for the merge gate (BOS-1070). GitHub makes a job's check run only when the
     * job starts, so the runs alone can read "passed" while later jobs haven't begun: the workflow's check suite, which stays
     * in progress until its last job ends, says whether anything is still to come. Suites with no runs are other apps' and are
     * left out (they can sit "queued" for ever). Elsewhere (Gitea) it is the commit statuses, as checks() reads them.
     */
    async ciStatus(cfg: GitHostConfig, token: string, sha: string): Promise<CiStatus> {
      if (cfg.kind !== "github") {
        const c = await this.checks(cfg, token, sha);
        return { state: c.state, failed: c.failing.map((name) => ({ id: 0, name, url: "" })), waiting: [], billing: false };
      }
      const suitesRes = await call(cfg, token, "GET", `/commits/${encodeURIComponent(sha)}/check-suites?per_page=100`);
      const suites = (suitesRes.json && !Array.isArray(suitesRes.json) ? suitesRes.json.check_suites : null) as Array<Record<string, unknown>> | null;
      if (!suitesRes.ok || !Array.isArray(suites)) throw new GitHostError(suitesRes.status, `Couldn't read the check suites on ${sha.slice(0, 8)}: ${messageOf(suitesRes.json, suitesRes.status)}`);
      const runsRes = await call(cfg, token, "GET", `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&filter=latest`);
      const runs = (runsRes.json && !Array.isArray(runsRes.json) ? runsRes.json.check_runs : null) as Array<Record<string, unknown>> | null;
      if (!runsRes.ok || !Array.isArray(runs)) throw new GitHostError(runsRes.status, `Couldn't read the checks on ${sha.slice(0, 8)}: ${messageOf(runsRes.json, runsRes.status)}`);
      const live = suites.filter((s) => Number(s.latest_check_runs_count) > 0);
      const failed = runs
        .filter((r) => FAILED_CONCLUSIONS.includes(String(r.conclusion)))
        .map((r) => ({ id: Number(r.id), name: String(r.name), url: String(r.html_url ?? r.details_url ?? "") }));
      const waiting = runs.filter((r) => r.status !== "completed").map((r) => String(r.name));
      const outputOf = (r: Record<string, unknown>) => {
        const o = (r.output ?? {}) as { title?: unknown; summary?: unknown };
        return `${String(o.title ?? "")} ${String(o.summary ?? "")}`;
      };
      const billing = runs.some((r) => FAILED_CONCLUSIONS.includes(String(r.conclusion)) && billingRefusal(outputOf(r)));
      const suiteFailed = live.some((s) => s.status === "completed" && FAILED_CONCLUSIONS.includes(String(s.conclusion)));
      const suitePending = live.some((s) => s.status !== "completed");
      const state = failed.length || suiteFailed ? "failed" : !live.length && !runs.length ? "none" : suitePending || waiting.length ? "pending" : "passed";
      return { state, failed, waiting, billing };
    },

    /**
     * The failure annotations of failed CI jobs (BOS-1070): vitest's GitHub reporter writes one per failing test, with its
     * name, so the agent is told what failed. Up to `per` lines per job; the generic "Process completed with exit code" goes.
     */
    async failures(cfg: GitHostConfig, token: string, runs: CiRun[], per = 10): Promise<Array<{ run: CiRun; lines: string[]; billing: boolean }>> {
      if (cfg.kind !== "github") return [];
      const out: Array<{ run: CiRun; lines: string[]; billing: boolean }> = [];
      for (const run of runs.slice(0, 5)) {
        const res = await call(cfg, token, "GET", `/check-runs/${run.id}/annotations?per_page=50`).catch(() => null);
        const rows = res?.ok && Array.isArray(res.json) ? res.json : [];
        const failing = rows.filter((a) => a.annotation_level === "failure");
        // Only GitHub's account-level note counts (no file, or ".github"): a test's annotation always names its file.
        const billing = failing.some((a) => (!a.path || a.path === ".github") && billingRefusal(`${String(a.title ?? "")} ${String(a.message ?? "")}`));
        const lines = failing
          .filter((a) => !/^Process completed with exit code/i.test(String(a.message ?? "")))
          .map((a) => {
            const where = typeof a.path === "string" && a.path && a.path !== ".github" ? `${a.path}${a.start_line ? `:${a.start_line}` : ""}: ` : "";
            const title = typeof a.title === "string" && a.title ? `${a.title}: ` : "";
            return `${where}${title}${String(a.message ?? "").split("\n")[0]}`.slice(0, 300);
          })
          .slice(0, per);
        out.push({ run, lines, billing });
      }
      return out;
    },

    /** The checks on a commit: GitHub check runs, or Gitea's commit statuses. */
    async checks(cfg: GitHostConfig, token: string, sha: string): Promise<CommitChecks> {
      const gh = cfg.kind === "github";
      const res = await call(cfg, token, "GET", gh ? `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100` : `/commits/${encodeURIComponent(sha)}/status`);
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
        steps: (Array.isArray(j.steps) ? (j.steps as Array<Record<string, unknown>>) : []).map((s) => ({
          number: Number(s.number ?? 0),
          name: String(s.name ?? "step"),
          status: String(s.status ?? ""),
          conclusion: typeof s.conclusion === "string" ? s.conclusion : null,
        })),
      }));
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

    async get(cfg: GitHostConfig, token: string, number: number): Promise<PullRequest> {
      const res = await call(cfg, token, "GET", `/pulls/${number}`);
      if (!res.ok || !res.json || Array.isArray(res.json)) throw new GitHostError(res.status, `Couldn't read pull request ${number}: ${messageOf(res.json, res.status)}`);
      return toPull(res.json);
    },
  };
}
