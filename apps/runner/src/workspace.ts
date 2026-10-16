// Git workspaces (R38): one worktree per ticket, on its own branch, from a pinned base.
//
// Layout under the workspaces volume:
//   repos/<projectId>.git     a bare clone per project, shared by its tickets
//   tickets/<ticketId>        the ticket's worktree, on branch bossman/<ticket>
//   patches/<ticketId>.patch  uncommitted work saved when a worktree is released
//
// Lessons from cline/kanban: creation is serialised per repo, an existing worktree is never
// recreated because the base moved, uncommitted work survives clean-up as a patch, and only
// the clone itself is provisioned, so ignored local files like .env never leak in.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type WorkspaceSpec = { projectId: string; ticketId: string; repoUrl: string; baseRef: string };
export type WorkspaceInfo = { path: string; branch: string; baseCommit: string; created: boolean; restoredPatch: boolean };

/**
 * Git credentials from the run's granted secrets, passed through the environment only.
 * Nothing is written to a URL or to git config on disk. GIT_TOKEN is sent as HTTP Basic
 * auth (GitHub, GitLab and Gitea accept a token this way); GIT_USERNAME defaults to
 * x-access-token.
 */
export function gitAuthEnv(secrets: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (secrets.GIT_TOKEN) {
    const basic = Buffer.from(`${secrets.GIT_USERNAME ?? "x-access-token"}:${secrets.GIT_TOKEN}`).toString("base64");
    Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` });
  }
  return env;
}

export const branchFor = (ticketId: string) => `bossman/${ticketId}`;

export class Workspaces {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly root: string,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  repoDir = (projectId: string) => path.join(this.root, "repos", `${projectId}.git`);
  ticketDir = (ticketId: string) => path.join(this.root, "tickets", ticketId);
  patchFile = (ticketId: string) => path.join(this.root, "patches", `${ticketId}.patch`);

  private async git(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
    const env = { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, HTTPS_PROXY: this.baseEnv.HTTPS_PROXY, NO_PROXY: this.baseEnv.NO_PROXY, ...opts.env };
    const { stdout } = await run("git", args, { cwd: opts.cwd, env: env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  /**
   * Serialises work on one repo: in-process with a promise chain, and across processes with
   * a lock directory in the repo's folder. A lock left by a dead process expires after 10 minutes.
   */
  private async withRepoLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const lockDir = path.join(this.root, "repos", `${projectId}.lock`);
      mkdirSync(path.dirname(lockDir), { recursive: true });
      for (let i = 0; ; i++) {
        try {
          mkdirSync(lockDir);
          break;
        } catch {
          const age = Date.now() - (statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
          if (age > 10 * 60_000) rmSync(lockDir, { recursive: true, force: true });
          else if (i > 600) throw new Error(`Timed out waiting for the lock on ${projectId}.`);
          else await new Promise((r) => setTimeout(r, 100));
        }
      }
      try {
        return await fn();
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    });
    this.locks.set(projectId, next);
    return next as Promise<T>;
  }

  /** The ticket's worktree, created on first use and reused (never recreated) after that. */
  async ensure(spec: WorkspaceSpec, secrets: Record<string, string | undefined> = {}): Promise<WorkspaceInfo> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      const dir = this.ticketDir(spec.ticketId);
      const branch = branchFor(spec.ticketId);
      const baseKey = `bossman.ticket-${spec.ticketId}.base`;

      if (!existsSync(path.join(repo, "HEAD"))) {
        mkdirSync(path.dirname(repo), { recursive: true });
        await this.git(["clone", "--bare", "--quiet", spec.repoUrl, repo], { env: auth });
        // Remote branches go under refs/remotes, so fetching never touches the bossman/* branches.
        await this.git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: repo });
      }

      if (existsSync(path.join(dir, ".git"))) {
        const baseCommit = await this.git(["config", "--get", baseKey], { cwd: repo }).catch(() => "");
        return { path: dir, branch, baseCommit, created: false, restoredPatch: false };
      }

      await this.git(["fetch", "--quiet", "origin"], { cwd: repo, env: auth });
      await this.git(["worktree", "prune"], { cwd: repo });
      const branchExists = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }).then(
        () => true,
        () => false,
      );
      let baseCommit: string;
      if (branchExists) {
        // Released earlier: carry on from the branch and keep the original base.
        baseCommit = (await this.git(["config", "--get", baseKey], { cwd: repo }).catch(() => "")) || (await this.git(["rev-parse", branch], { cwd: repo }));
        await this.git(["worktree", "add", "--quiet", dir, branch], { cwd: repo });
      } else {
        baseCommit = await this.git(["rev-parse", "--verify", `${spec.baseRef.match(/^[0-9a-f]{7,40}$/) ? spec.baseRef : `refs/remotes/origin/${spec.baseRef}`}^{commit}`], { cwd: repo });
        await this.git(["worktree", "add", "--quiet", "-b", branch, dir, baseCommit], { cwd: repo });
        await this.git(["config", baseKey, baseCommit], { cwd: repo });
      }

      let restoredPatch = false;
      const patch = this.patchFile(spec.ticketId);
      if (existsSync(patch)) {
        await this.git(["apply", "--whitespace=nowarn", patch], { cwd: dir });
        rmSync(patch);
        restoredPatch = true;
      }
      return { path: dir, branch, baseCommit, created: true, restoredPatch };
    });
  }

  /**
   * Frees the worktree. Uncommitted work, tracked or not, is saved as a patch first and put
   * back the next time the ticket's workspace is made. The branch and its commits stay.
   */
  async release(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">): Promise<{ savedPatch: boolean }> {
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      const dir = this.ticketDir(spec.ticketId);
      if (!existsSync(path.join(dir, ".git"))) return { savedPatch: false };
      await this.git(["add", "-A"], { cwd: dir });
      const diff = await this.git(["diff", "--cached", "--binary", "HEAD"], { cwd: dir });
      let savedPatch = false;
      if (diff) {
        mkdirSync(path.dirname(this.patchFile(spec.ticketId)), { recursive: true });
        writeFileSync(this.patchFile(spec.ticketId), `${diff}\n`);
        savedPatch = true;
      }
      await this.git(["worktree", "remove", "--force", dir], { cwd: repo });
      await this.git(["worktree", "prune"], { cwd: repo });
      return { savedPatch };
    });
  }

  /** For tests and the run view: the saved patch, if any. */
  savedPatch(ticketId: string): string | null {
    const f = this.patchFile(ticketId);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  }
}
