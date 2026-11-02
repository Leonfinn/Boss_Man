// Git workspaces (R38): one worktree per ticket, on its own branch, from a pinned base.
//
// Layout under the workspaces volume:
//   repos/<projectId>.git     a bare clone per project, shared by its tickets
//   tickets/<ticketId>        the ticket's worktree, on branch bossman/<ticket>
//   reviews/<ticketId>        a reviewer's own detached copy of that work
//   patches/<ticketId>.patch  uncommitted work saved when a worktree is released
//
// Lessons from cline/kanban: creation is serialised per repo, an existing worktree is never
// recreated because the base moved, uncommitted work survives clean-up as a patch, and only
// the clone itself is provisioned, so ignored local files like .env never leak in.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CHECK_TOOLS, detectChecks, type CarriedResult, type DetectResult, type DiskReport, type MergeResult, type MigrationsResult, type PushResult, type VerifyResult, type WorkspaceDiff, CHECK_QUEUED_MARKER, CHECK_STARTED_MARKER, VERIFY_QUEUE_MAX_MS, VERIFY_TIMEOUT_MS } from "@boss-man/shared";
import { checkMigrations } from "./migrations.js";

const run = promisify(execFile);
const VERIFY_KILL_GRACE_MS = 2000;

export type WorkspaceSpec = { projectId: string; ticketId: string; repoUrl: string; baseRef: string; review?: boolean };
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bytes on disk under a path, without following symlinks. */
export async function diskUsage(target: string): Promise<number> {
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p).catch(() => null);
    if (!st) return;
    // Allocated blocks where the platform reports them, so sparse files aren't overcounted.
    total += typeof st.blocks === "number" ? st.blocks * 512 : st.size;
    if (!st.isDirectory()) return;
    const names = await readdir(p).catch(() => [] as string[]);
    for (const n of names) await walk(path.join(p, n));
  };
  await walk(target);
  return total;
}

/**
 * Settings for every git call the runner makes itself. A repo's own config can name a hook folder
 * or a filesystem monitor, and both run programs, so a shared repo could otherwise run code inside
 * the daemon. GIT_CONFIG_* sits above the repo's config file, so it wins.
 */
export const SAFE_GIT_ENV = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

/**
 * SAFE_GIT_ENV plus the caller's own env. GIT_CONFIG_* entries are numbered, so a caller's entries
 * (the auth header from gitAuthEnv) are renumbered after ours instead of overwriting them.
 */
export function safeGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const own = Number(SAFE_GIT_ENV.GIT_CONFIG_COUNT);
  const n = Number(extra.GIT_CONFIG_COUNT) || 0;
  const env: Record<string, string> = { ...extra, ...SAFE_GIT_ENV };
  for (let i = 0; i < n; i++) {
    env[`GIT_CONFIG_KEY_${own + i}`] = extra[`GIT_CONFIG_KEY_${i}`] ?? "";
    env[`GIT_CONFIG_VALUE_${own + i}`] = extra[`GIT_CONFIG_VALUE_${i}`] ?? "";
  }
  env.GIT_CONFIG_COUNT = String(own + n);
  return env;
}

export class Workspaces {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly root: string,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  repoDir = (projectId: string) => path.join(this.root, "repos", `${projectId}.git`);
  ticketDir = (ticketId: string) => path.join(this.root, "tickets", ticketId);
  reviewDir = (ticketId: string) => path.join(this.root, "reviews", ticketId);
  patchFile = (ticketId: string) => path.join(this.root, "patches", `${ticketId}.patch`);

  /**
   * Who its commits say made them. The agent's current display name (sent with each run,
   * BOS-265), so a rename shows at once; Boss Man's own commits (checkpoints, a review copy, a
   * merge) are always Boss Man, since they aren't the agent's work.
   */
  private authorEnv(by?: string) {
    const name = by?.trim().slice(0, 200) || "Boss Man";
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: "bossman@localhost", GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: "bossman@localhost" };
  }

  private async git(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
    const env = { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, HTTPS_PROXY: this.baseEnv.HTTPS_PROXY, NO_PROXY: this.baseEnv.NO_PROXY, ...safeGitEnv(opts.env) };
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

      await this.cloneIfMissing(spec, auth);

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
   * A ticket's worktree for its check or diff. One released or cleaned up since (the branch is
   * kept) is put back from the branch, with any work saved at release; with no branch either,
   * there is nothing to check.
   */
  private async reopen(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">): Promise<string> {
    const dir = this.ticketDir(spec.ticketId);
    if (existsSync(path.join(dir, ".git"))) return dir;
    return this.withRepoLock(spec.projectId, async () => {
      if (existsSync(path.join(dir, ".git"))) return dir;
      const repo = this.repoDir(spec.projectId);
      const branch = branchFor(spec.ticketId);
      const has = existsSync(repo) && (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }).then(() => true, () => false));
      if (!has) throw new Error("That ticket has no workspace or branch on this runner.");
      await this.git(["worktree", "prune"], { cwd: repo });
      await this.git(["worktree", "add", "--quiet", dir, branch], { cwd: repo });
      const patch = this.patchFile(spec.ticketId);
      if (existsSync(patch)) {
        await this.git(["apply", "--whitespace=nowarn", patch], { cwd: dir });
        rmSync(patch);
      }
      return dir;
    });
  }

  private async cloneIfMissing(spec: Pick<WorkspaceSpec, "projectId" | "repoUrl">, auth: Record<string, string>) {
    const repo = this.repoDir(spec.projectId);
    if (existsSync(path.join(repo, "HEAD"))) return;
    mkdirSync(path.dirname(repo), { recursive: true });
    await this.git(["clone", "--bare", "--quiet", spec.repoUrl, repo], { env: auth });
    // Remote branches go under refs/remotes, so fetching never touches the bossman/* branches.
    await this.git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: repo });
  }

  /**
   * A reviewer's own copy of a ticket's latest work: the developer's worktree as it is now,
   * uncommitted and untracked files included, or the ticket's branch when the worktree isn't
   * here. Detached and in its own folder, so whatever the reviewer does there never reaches the
   * ticket. Each review run resets it to the latest work; ignored files (installed packages) stay.
   */
  async ensureReview(spec: WorkspaceSpec, secrets: Record<string, string | undefined> = {}): Promise<{ path: string; commit: string }> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      await this.cloneIfMissing(spec, auth);
      const repo = this.repoDir(spec.projectId);
      const dev = this.ticketDir(spec.ticketId);
      const dir = this.reviewDir(spec.ticketId);
      let commit: string;
      if (existsSync(path.join(dev, ".git"))) commit = await this.snapshot(dev);
      else {
        await this.git(["fetch", "--quiet", "origin"], { cwd: repo, env: auth });
        const branch = branchFor(spec.ticketId);
        commit = await this.git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd: repo }).catch(() =>
          this.git(["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], { cwd: repo }).catch(() => {
            throw new Error("That ticket has no work on this runner to review.");
          }),
        );
      }
      if (existsSync(path.join(dir, ".git"))) {
        await this.git(["checkout", "--quiet", "--force", "--detach", commit], { cwd: dir });
        await this.git(["clean", "-fdq"], { cwd: dir });
      } else {
        await this.git(["worktree", "prune"], { cwd: repo });
        mkdirSync(path.dirname(dir), { recursive: true });
        await this.git(["worktree", "add", "--quiet", "--detach", dir, commit], { cwd: repo });
      }
      return { path: dir, commit };
    });
  }

  /** The worktree as it is now, as a commit no ref points at; its branch, index and files are untouched. */
  private async snapshot(dir: string): Promise<string> {
    const index = path.join(this.root, "tmp", `${path.basename(dir)}.review.index`);
    mkdirSync(path.dirname(index), { recursive: true });
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(["read-tree", "HEAD"], { cwd: dir, env });
      await this.git(["add", "-A"], { cwd: dir, env });
      const tree = await this.git(["write-tree"], { cwd: dir, env });
      const who = this.authorEnv();
      return await this.git(["commit-tree", tree, "-p", "HEAD", "-m", "Boss Man review copy"], { cwd: dir, env: who });
    } finally {
      rmSync(index, { force: true });
    }
  }

  /**
   * Frees the worktree. Uncommitted work, tracked or not, is saved as a patch first and put
   * back the next time the ticket's workspace is made. The branch and its commits stay.
   */
  async release(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">): Promise<{ savedPatch: boolean }> {
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      const dir = this.ticketDir(spec.ticketId);
      // The reviewer's copy goes with the ticket; nothing in it is kept.
      if (existsSync(path.join(this.reviewDir(spec.ticketId), ".git"))) await this.git(["worktree", "remove", "--force", this.reviewDir(spec.ticketId)], { cwd: repo });
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
      // Turn checkpoints only matter while the ticket is being worked on.
      for (const c of await this.checkpoints(spec.projectId, spec.ticketId)) await this.git(["update-ref", "-d", c.ref], { cwd: repo });
      return { savedPatch };
    });
  }

  /**
   * The ticket's changes against its base: committed, uncommitted and untracked, honouring
   * .gitignore. A throwaway index is used, so the agent's own index is untouched.
   */
/**
   * One file of a ticket's work, for agents reading what another ticket produced (R77): from
   * its worktree when it has one here (uncommitted work included), else from its branch.
   */
  async readFile(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, file: string, maxBytes = 256 * 1024): Promise<{ text: string; truncated: boolean; from: "worktree" | "branch" }> {
    const rel = path.posix.normalize(file.replace(/\\/g, "/")).replace(/^\/+/, "");
    if (!rel || rel === "." || rel.startsWith("..") || rel.startsWith("-") || rel.includes("\0")) throw new Error("That isn't a path inside the repository.");
    const dir = this.ticketDir(spec.ticketId);
    let data: Buffer;
    let from: "worktree" | "branch";
    const inTree = path.resolve(dir, rel);
    // A symlink in the worktree mustn't lead outside it.
    if (existsSync(path.join(dir, ".git")) && inTree.startsWith(dir + path.sep) && existsSync(inTree) && realpathSync(inTree).startsWith(realpathSync(dir) + path.sep)) {
      data = readFileSync(inTree);
      from = "worktree";
    } else {
      const repo = this.repoDir(spec.projectId);
      if (!existsSync(repo)) throw new Error("This runner has no copy of that project's repo.");
      const { stdout } = await run("git", ["show", `${branchFor(spec.ticketId)}:${rel}`], { cwd: repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, ...SAFE_GIT_ENV } as NodeJS.ProcessEnv }).catch(() => {
        throw new Error(`There's no ${rel} on that ticket's branch.`);
      });
      data = stdout as unknown as Buffer;
      from = "branch";
    }
    if (data.includes(0)) throw new Error(`${rel} is a binary file.`);
    const truncated = data.length > maxBytes;
    return { text: data.subarray(0, maxBytes).toString("utf8"), truncated, from };
  }

  /**
   * An image the agent saved while working a ticket (a screenshot), for attaching to it: from the ticket's
   * worktree, its review copy, or the plain working folder of a ticket without a repo. A relative path is
   * taken from the first of those that has it; an absolute one must be inside one of them.
   */
  readImage(ticketId: string, file: string, maxBytes = 5 * 1024 * 1024): { base64: string; size: number } {
    if (!file || file.includes("\0")) throw new Error("Give the image's path.");
    const dirs = [this.ticketDir(ticketId), this.reviewDir(ticketId), path.join(this.root, ticketId)].filter((d) => existsSync(d)).map((d) => realpathSync(d));
    const candidates = path.isAbsolute(file) ? [path.resolve(file)] : dirs.map((d) => path.resolve(d, file));
    for (const c of candidates) {
      if (!existsSync(c)) continue;
      // A symlink mustn't lead out of the ticket's folders.
      const real = realpathSync(c);
      if (!dirs.some((d) => real.startsWith(d + path.sep))) continue;
      const size = statSync(real).size;
      if (size > maxBytes) throw new Error(`${file} is ${Math.ceil(size / 1024)} KB; images are limited to ${maxBytes / 1024 / 1024} MB.`);
      return { base64: readFileSync(real).toString("base64"), size };
    }
    throw new Error(`There's no ${file} in this ticket's working folder. Save the image there (a path relative to where you work) and try again.`);
  }

  async diff(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, maxBytes = 512 * 1024): Promise<WorkspaceDiff> {
    const repo = this.repoDir(spec.projectId);
    const dir = await this.reopen(spec);
    const baseCommit = await this.git(["config", "--get", `bossman.ticket-${spec.ticketId}.base`], { cwd: repo });
    const head = await this.git(["rev-parse", "HEAD"], { cwd: dir });
    const log = await this.git(["log", "--format=%H%x09%s", `${baseCommit}..HEAD`], { cwd: dir });
    const commits = log ? log.split("\n").map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })) : [];
    const index = path.join(this.root, "tmp", `${spec.ticketId}.index`);
    mkdirSync(path.dirname(index), { recursive: true });
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(["read-tree", "HEAD"], { cwd: dir, env });
      await this.git(["add", "-A"], { cwd: dir, env });
      const numstat = await this.git(["diff", "--cached", "--numstat", baseCommit], { cwd: dir, env });
      const files = numstat
        ? numstat.split("\n").map((l) => {
            const [a, r, ...p] = l.split("\t");
            return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r) };
          })
        : [];
      const full = await this.git(["diff", "--cached", baseCommit], { cwd: dir, env });
      const truncated = Buffer.byteLength(full) > maxBytes;
      return { baseCommit, head, commits, files, diff: truncated ? full.slice(0, maxBytes) : full, truncated };
    } finally {
      rmSync(index, { force: true });
    }
  }

  /** Private refs holding each ticket's turn checkpoints, oldest first. */
  checkpointPrefix = (ticketId: string) => `refs/bossman/checkpoints/${ticketId}/`;

  private async checkpoints(projectId: string, ticketId: string): Promise<Array<{ ref: string; n: number; commit: string; at: string; subject: string }>> {
    const out = await this.git(["for-each-ref", "--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)%09%(subject)", this.checkpointPrefix(ticketId)], { cwd: this.repoDir(projectId) });
    return out
      ? out
          .split("\n")
          .map((l) => {
            const [ref, commit, at, ...subject] = l.split("\t") as [string, string, string, ...string[]];
            return { ref, n: Number(ref.slice(ref.lastIndexOf("/") + 1)), commit, at, subject: subject.join("\t") };
          })
          .sort((a, b) => a.n - b.n)
      : [];
  }

  /**
   * Records the worktree as it is now, tracked, uncommitted and untracked work alike (R39),
   * as a commit under the ticket's private checkpoint refs. A throwaway index and commit-tree
   * are used, so the agent's branch, index and working files are untouched. Nothing is
   * recorded when nothing changed since the last checkpoint.
   */
  async checkpoint(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, label: string, by?: string): Promise<{ turn: number; commit: string; files: number } | null> {
    const dir = this.ticketDir(spec.ticketId);
    if (!existsSync(path.join(dir, ".git"))) return null;
    const index = path.join(this.root, "tmp", `${spec.ticketId}.checkpoint.index`);
    mkdirSync(path.dirname(index), { recursive: true });
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(["read-tree", "HEAD"], { cwd: dir, env });
      await this.git(["add", "-A"], { cwd: dir, env });
      const tree = await this.git(["write-tree"], { cwd: dir, env });
      const list = await this.checkpoints(spec.projectId, spec.ticketId);
      const last = list[list.length - 1];
      const parent = last?.commit ?? (await this.git(["rev-parse", "HEAD"], { cwd: dir }));
      if ((await this.git(["rev-parse", `${parent}^{tree}`], { cwd: dir })) === tree) return null;
      const commit = await this.git(["commit-tree", tree, "-p", parent, "-m", `Boss Man checkpoint: ${label}`], { cwd: dir, env: this.authorEnv(by) });
      const turn = (last?.n ?? 0) + 1;
      await this.git(["update-ref", `${this.checkpointPrefix(spec.ticketId)}${String(turn).padStart(6, "0")}`, commit], { cwd: dir });
      const files = await this.git(["diff", "--name-only", parent, commit], { cwd: dir });
      return { turn, commit, files: files ? files.split("\n").length : 0 };
    } finally {
      rmSync(index, { force: true });
    }
  }

  /**
   * What the agent's last turn that changed anything did: that turn's checkpoint against the
   * one before it (or the branch head it started from). Checkpoints taken before a run, which
   * catch changes made outside a turn, are never shown as a turn.
   */
  async lastTurnDiff(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, maxBytes = 512 * 1024): Promise<WorkspaceDiff> {
    const list = await this.checkpoints(spec.projectId, spec.ticketId);
    const to = list.filter((c) => c.subject.includes("after a turn")).pop();
    if (!to) throw new Error("No turn has changed anything yet.");
    const from = { commit: await this.git(["rev-parse", `${to.commit}^`], { cwd: this.repoDir(spec.projectId) }) };
    const cwd = this.repoDir(spec.projectId);
    const numstat = await this.git(["diff", "--numstat", from.commit, to.commit], { cwd });
    const files = numstat
      ? numstat.split("\n").map((l) => {
          const [a, r, ...p] = l.split("\t");
          return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r) };
        })
      : [];
    const full = await this.git(["diff", from.commit, to.commit], { cwd });
    const truncated = Buffer.byteLength(full) > maxBytes;
    return { baseCommit: from.commit, head: to.commit, commits: [], files, diff: truncated ? full.slice(0, maxBytes) : full, truncated, turn: { number: to.n, at: to.at } };
  }

  /** Runs git and returns its exit code instead of throwing on a non-zero exit. */
  private async gitCode(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      return { code: 0, stdout: (await this.git(args, opts)) ?? "", stderr: "" };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      if (typeof e.code !== "number") throw err;
      return { code: e.code, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "").trim() };
    }
  }

  /**
   * Says whether the ticket's new migration numbers are free (BOS-219), against the default branch
   * and the other open branches. Read-only on the bare clone: nothing is checked out or run, and a
   * branch it can't read gives "couldn't say" rather than stopping the ticket.
   */
  async migrations(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, others: string[], secrets: Record<string, string | undefined> = {}): Promise<MigrationsResult> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      if (!existsSync(repo)) return { needed: null, reason: "This runner has no copy of the repository yet, so there was nothing to compare." };
      return checkMigrations((args) => this.gitCode(args, { cwd: repo, env: auth }), repo, { branch: branchFor(spec.ticketId), target, others });
    });
  }

  /**
   * Runs the ticket's check (e.g. "pnpm test") in its worktree (R47). Output is kept to the
   * last 8 KB. It runs without the company's secrets: a check shouldn't need them.
   */
  async verify(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, command: string, timeoutMs = VERIFY_TIMEOUT_MS, queueMaxMs = VERIFY_QUEUE_MAX_MS): Promise<VerifyResult> {
    const dir = await this.reopen(spec);
    const started = Date.now();
    return new Promise<VerifyResult>((resolve) => {
      // Own process group, so a timeout can take down pnpm, tsc, vitest and their workers, not just the shell.
      const child = spawn("sh", ["-c", command], {
        cwd: dir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        // BOSSMAN_MERGE_CHECK: scripts/check-all.sh lets the merge check take the shared lock ahead of agents' hand-run checks.
        env: { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, CI: "1", BOSSMAN_MERGE_CHECK: "1" } as NodeJS.ProcessEnv,
      });
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          // group already gone
        }
      };
      let tail = "";
      // While check-all.sh waits in its queue the clock is the (long) queue limit; it restarts at the full timeout once the checks really begin.
      let queued = false;
      let slotTaken = false;
      const onData = (chunk: string) => {
        tail = (tail + chunk).slice(-8192);
        if (!slotTaken && tail.includes(CHECK_STARTED_MARKER)) {
          slotTaken = true;
          arm(timeoutMs);
        } else if (!queued && !slotTaken && tail.includes(CHECK_QUEUED_MARKER)) {
          queued = true;
          arm(queueMaxMs);
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      let timedOut = false;
      let finished = false;
      let hardKill: NodeJS.Timeout | undefined;
      const finish = (exitCode: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(hardKill);
        killGroup("SIGKILL"); // strays left behind by a check that has already exited
        resolve({ ok: !timedOut && exitCode === 0, exitCode: timedOut ? null : exitCode, timedOut, output: tail, ms: Date.now() - started });
      };
      let timer: NodeJS.Timeout;
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
          hardKill = setTimeout(() => finish(null), VERIFY_KILL_GRACE_MS);
        }, ms);
      };
      arm(timeoutMs);
      child.on("error", (err) => {
        tail += String(err.message);
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  }

  /**
   * Merges the ticket's branch into a named target without any working tree (R46). The merge is
   * tried with merge-tree (exit codes, never output text); a clean result becomes a merge
   * commit pushed to the target. Nothing is cleaned or reset, so files outside the ticket's
   * worktree can't be touched. If the target moved meanwhile, the push is rejected and the
   * merge is tried once more.
   */
  async merge(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, message: string, secrets: Record<string, string | undefined> = {}): Promise<MergeResult> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      const dir = this.ticketDir(spec.ticketId);
      const branch = `refs/heads/${branchFor(spec.ticketId)}`;
      if (existsSync(path.join(dir, ".git"))) {
        const dirty = await this.git(["status", "--porcelain"], { cwd: dir });
        if (dirty) return { status: "uncommitted", files: dirty.split("\n").map((l) => l.slice(3)) };
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const tried = await this.tryMerge(repo, branch, target, auth);
        if (tried.status !== "clean") return tried;
        const { tree, targetSha, branchSha } = tried;
        const who = this.authorEnv();
        const commit = await this.git(["commit-tree", tree, "-p", targetSha, "-p", branchSha, "-m", message], { cwd: repo, env: who });
        const pushed = await this.gitCode(["push", "--quiet", "origin", `${commit}:refs/heads/${target}`], { cwd: repo, env: auth });
        if (pushed.code === 0) return { status: "merged", commit };
        if (attempt === 1) throw new Error(`Couldn't push the merge to ${target}: ${pushed.stderr.slice(0, 500)}`);
      }
      throw new Error("unreachable");
    });
  }

  /** Fetches, then tries the ticket's branch on top of origin's target with merge-tree. */
  private async tryMerge(repo: string, branch: string, target: string, auth: Record<string, string>) {
    await this.git(["fetch", "--quiet", "origin"], { cwd: repo, env: auth });
    const targetSha = await this.git(["rev-parse", "--verify", `refs/remotes/origin/${target}^{commit}`], { cwd: repo });
    const branchSha = await this.git(["rev-parse", "--verify", `${branch}^{commit}`], { cwd: repo });
    const ancestor = await this.gitCode(["merge-base", "--is-ancestor", branchSha, targetSha], { cwd: repo });
    if (ancestor.code === 0) return { status: "already_merged" as const, commit: targetSha };
    const tried = await this.gitCode(["merge-tree", "--write-tree", "--name-only", "--messages", targetSha, branchSha], { cwd: repo });
    if (tried.code === 1) {
      const lines = tried.stdout.split("\n");
      const files = lines.slice(1, lines.indexOf("") === -1 ? undefined : lines.indexOf("")).filter(Boolean);
      return { status: "conflicts" as const, files };
    }
    if (tried.code !== 0) throw new Error(`git merge-tree failed (exit ${tried.code}): ${tried.stderr.slice(0, 500)}`);
    return { status: "clean" as const, tree: tried.stdout.split("\n")[0]!, targetSha, branchSha };
  }

  /**
   * Which other tickets' unmerged commits this ticket's branch carries (BOS-130): for another
   * ticket's branch B, its commits not yet on origin/target, and which of those this branch has.
   * A commit on this branch that only reached it by merging B means B was carried in; missing
   * branches are skipped, so a released branch on origin isn't known here and can't be checked.
   */
  async carried(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, branches: Array<{ ticketId: string; branch: string }>, secrets: Record<string, string | undefined> = {}): Promise<CarriedResult> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      if (!existsSync(path.join(repo, "HEAD"))) throw new Error("This runner has no copy of that project's repo.");
      await this.git(["fetch", "--quiet", "origin"], { cwd: repo, env: auth });
      // A failed rev-list mustn't look like "no commits": a safety gate that can't answer has to
      // say so, not report the branch clean (BOS-130).
      const refs = async (ref: string) => {
        const r = await this.gitCode(["rev-list", ref, "--not", `refs/remotes/origin/${target}`], { cwd: repo });
        if (r.code !== 0) throw new Error(`git rev-list ${ref} failed (exit ${r.code}): ${r.stderr.slice(0, 500)}`);
        return r.stdout.split("\n").filter(Boolean);
      };
      const mineRef = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchFor(spec.ticketId)}^{commit}`], { cwd: repo }).then(
        () => true,
        () => false,
      );
      // A ticket whose branch is gone here has nothing to compare: there is nothing of it to merge.
      if (!mineRef) return { carried: [] };
      const mine = new Set(await refs(branchFor(spec.ticketId)));
      const found: CarriedResult["carried"] = [];
      for (const b of branches) {
        if (b.ticketId === spec.ticketId || b.branch === branchFor(spec.ticketId)) continue;
        const exists = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${b.branch}^{commit}`], { cwd: repo }).then(
          () => true,
          () => false,
        );
        if (!exists) continue;
        if ((await refs(b.branch)).some((sha) => mine.has(sha))) found.push({ ticketId: b.ticketId, branch: b.branch });
      }
      return { carried: found };
    });
  }

  /**
   * Pushes the ticket's branch to origin for a pull request into target (R59), after the same
   * checks as a merge: nothing uncommitted, no conflicts with target. The host merges it.
   */
  async pushForReview(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, secrets: Record<string, string | undefined> = {}): Promise<PushResult> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      const dir = this.ticketDir(spec.ticketId);
      const name = branchFor(spec.ticketId);
      if (existsSync(path.join(dir, ".git"))) {
        const dirty = await this.git(["status", "--porcelain"], { cwd: dir });
        if (dirty) return { status: "uncommitted", files: dirty.split("\n").map((l) => l.slice(3)) };
      }
      const tried = await this.tryMerge(repo, `refs/heads/${name}`, target, auth);
      if (tried.status !== "clean") return tried;
      const pushed = await this.gitCode(["push", "--quiet", "origin", `${tried.branchSha}:refs/heads/${name}`], { cwd: repo, env: auth });
      if (pushed.code !== 0) throw new Error(`Couldn't push ${name}: ${pushed.stderr.slice(0, 500)}`);
      return { status: "pushed", branch: name, commit: tried.branchSha };
    });
  }

  /**
   * Proposes merge checks from the repo's top-level files on its default branch (R57), read
   * from the bare clone, so nothing is checked out and nothing in the repo runs. Also says
   * which tools this runner has, since a check can only pass with its tools installed.
   */
  async detect(spec: { projectId: string; repoUrl: string; baseRef: string }, secrets: Record<string, string | undefined> = {}): Promise<DetectResult> {
    const auth = gitAuthEnv(secrets);
    const checks = await this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      if (!existsSync(path.join(repo, "HEAD"))) {
        mkdirSync(path.dirname(repo), { recursive: true });
        await this.git(["clone", "--bare", "--quiet", spec.repoUrl, repo], { env: auth });
        await this.git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: repo });
      }
      await this.git(["fetch", "--quiet", "origin"], { cwd: repo, env: auth });
      const ref = `refs/remotes/origin/${spec.baseRef}`;
      const files = (await this.git(["ls-tree", "--name-only", ref], { cwd: repo })).split("\n").filter(Boolean);
      const texts = new Map<string, string | null>();
      for (const name of ["package.json", "Makefile", "makefile"].filter((n) => files.includes(n))) {
        const r = await this.gitCode(["show", `${ref}:${name}`], { cwd: repo });
        texts.set(name, r.code === 0 ? r.stdout.slice(0, 256 * 1024) : null);
      }
      return detectChecks(files, (n) => texts.get(n) ?? null);
    });
    const tools: Record<string, boolean> = {};
    for (const t of CHECK_TOOLS) tools[t] = await run("sh", ["-c", `command -v ${t}`]).then(
      () => true,
      () => false,
    );
    return { checks, tools };
  }

  /**
   * Clean-up and disk accounting (R54), run at start-up and hourly. Each repo's worktree
   * list is pruned of entries whose folder has gone, ticket folders git no longer knows
   * about are removed (only once they're 10 minutes old, so a worktree being created isn't
   * caught), and stray temp files go. Worktrees git does know about are left alone: the
   * server decides which tickets are finished and releases those, keeping their branches.
   */
  async housekeeping(now = Date.now()): Promise<DiskReport> {
    const removed: string[] = [];
    const reposDir = path.join(this.root, "repos");
    const ticketsDir = path.join(this.root, "tickets");
    const list = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

    for (const name of list(reposDir).filter((n) => n.endsWith(".git"))) {
      const projectId = name.slice(0, -4);
      await this.withRepoLock(projectId, () => this.git(["worktree", "prune"], { cwd: this.repoDir(projectId) })).catch(() => undefined);
    }

    const tickets: DiskReport["tickets"] = [];
    for (const ticketId of list(ticketsDir)) {
      const dir = path.join(ticketsDir, ticketId);
      const gitFile = path.join(dir, ".git");
      // A worktree's .git is a file naming its admin folder inside the bare repo.
      const pointer = existsSync(gitFile) ? readFileSync(gitFile, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() : undefined;
      const projectId = pointer?.match(/repos\/([^/]+)\.git\/worktrees\//)?.[1] ?? null;
      if (!pointer || !existsSync(pointer) || !projectId) {
        const age = now - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? now);
        if (age > 10 * 60_000) {
          rmSync(dir, { recursive: true, force: true });
          removed.push(ticketId);
        }
        continue;
      }
      if (UUID.test(ticketId) && UUID.test(projectId)) tickets.push({ ticketId, projectId, bytes: await diskUsage(dir) });
    }

    // A review copy git no longer knows about (its repo pruned it) is only clutter.
    for (const ticketId of list(path.join(this.root, "reviews"))) {
      const dir = path.join(this.root, "reviews", ticketId);
      const pointer = existsSync(path.join(dir, ".git")) ? readFileSync(path.join(dir, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() : undefined;
      if ((!pointer || !existsSync(pointer)) && now - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? now) > 10 * 60_000) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(ticketId);
      }
    }

    const tmp = path.join(this.root, "tmp");
    for (const f of list(tmp)) {
      const p = path.join(tmp, f);
      if (now - (statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? now) > 3_600_000) rmSync(p, { recursive: true, force: true });
    }

    const repos = await Promise.all(list(reposDir).filter((n) => n.endsWith(".git")).map(async (n) => ({ projectId: n.slice(0, -4), bytes: await diskUsage(path.join(reposDir, n)) })));
    const patchesBytes = await diskUsage(path.join(this.root, "patches"));
    const usedBytes = tickets.reduce((a, t) => a + t.bytes, 0) + repos.reduce((a, r) => a + r.bytes, 0) + patchesBytes;
    return { usedBytes, tickets, repos, removed };
  }

  /** For tests and the run view: the saved patch, if any. */
  savedPatch(ticketId: string): string | null {
    const f = this.patchFile(ticketId);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  }
}
