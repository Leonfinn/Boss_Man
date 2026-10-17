// Pull requests on the project's git host (R59): Gitea or GitHub, through their REST APIs.
// Gitea's fields were checked against the v28.0.0 swagger (templates/swagger in the source):
// CreatePullRequestOption {title, head, base, body}; MergePullRequestOption {do, merge_title_field,
// merge_message_field, head_commit_id}; merge answers 200, or 405 (not allowed yet: approvals,
// status checks, permissions) and 409 (conflicts, head out of date) with a message.
import { apiBaseFor, parseRepoUrl, type GitHostKind } from "@boss-man/shared";

export type GitHostConfig = { kind: GitHostKind; apiBase: string; owner: string; repo: string };
export type PullRequest = { number: number; url: string; merged: boolean; closed: boolean; mergeCommit: string | null };
export type MergeAttempt = { merged: true; commit: string | null } | { merged: false; note: string };

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

    async get(cfg: GitHostConfig, token: string, number: number): Promise<PullRequest> {
      const res = await call(cfg, token, "GET", `/pulls/${number}`);
      if (!res.ok || !res.json || Array.isArray(res.json)) throw new GitHostError(res.status, `Couldn't read pull request ${number}: ${messageOf(res.json, res.status)}`);
      return toPull(res.json);
    },
  };
}
