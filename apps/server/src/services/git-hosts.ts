// Pull requests on the project's git host (R59): Gitea or GitHub, through their REST APIs.
// Gitea's fields were checked against the v28.0.0 swagger (templates/swagger in the source):
// CreatePullRequestOption {title, head, base, body}; MergePullRequestOption {do, merge_title_field,
// merge_message_field, head_commit_id}; merge answers 200, or 405 (not allowed yet: approvals,
// status checks, permissions) and 409 (conflicts, head out of date) with a message.
import { apiBaseFor, parseRepoUrl, type GitHostKind } from "@boss-man/shared";

export type GitHostConfig = { kind: GitHostKind; apiBase: string; owner: string; repo: string };
export type PullRequest = { number: number; url: string; merged: boolean; closed: boolean; mergeCommit: string | null };
/** What a commit's checks say (R86). GitHub's older commit statuses (not Actions check runs) aren't read. */
export type CommitChecks = { state: "passed" | "failed" | "pending" | "none"; failing: string[]; total?: number; /** A page for the run: the first failing one, else the first reported (BOS-1418). */ url?: string };
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

export function gitHostService(opts: { fetch?: typeof fetch } = {}) {
  const http = opts.fetch ?? fetch;

  async function call(cfg: GitHostConfig, token: string, method: string, path: string, body?: unknown) {
    const headers: Record<string, string> =
      cfg.kind === "github"
        ? { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }
        : { authorization: `token ${token}`, accept: "application/json" };
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
    async checkAccess(cfg: GitHostConfig, token: string): Promise<{ ok: boolean; canPush: boolean; message: string }> {
      const res = await call(cfg, token, "GET", "");
      if (res.status === 401 || res.status === 403) return { ok: false, canPush: false, message: `The host refused the token (HTTP ${res.status}).` };
      if (res.status === 404) return { ok: false, canPush: false, message: "The token can't see the repo: check its owner and name, and that the token has access to it." };
      if (!res.ok || !res.json || Array.isArray(res.json)) return { ok: false, canPush: false, message: `The host answered ${res.status}.` };
      const perms = (res.json.permissions ?? {}) as { push?: boolean; admin?: boolean };
      const canPush = perms.push === true || perms.admin === true;
      return { ok: true, canPush, message: canPush ? "The token can read and push to the repo." : "The token can read the repo but not push to it, so merges and pull requests would fail." };
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
