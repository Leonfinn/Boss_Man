// Git workspaces (R38): one copy per ticket, on its own branch, from a pinned base.
//
// Layout under the workspaces volume:
//   repos/<projectId>.git     a bare clone per project, shared by its tickets
//   tickets/<ticketId>        the ticket's copy, on branch bossman/<ticket>
//   reviews/<ticketId>        a reviewer's own detached copy of that work
//   patches/<ticketId>.patch  uncommitted work saved when a copy is released
//
// A copy is either a worktree of the shared repo (a .git file) or, since BOS-323, the ticket's
// own clone that borrows the shared repo's objects read-only (a .git folder). A clone keeps its
// branches, config and hooks to itself, so one ticket can't plant code the runner later runs for
// another, or delete another ticket's branch. Its branch is fetched back into the shared repo
// (syncBranch), where merges, pushes and other tickets read it. Every operation handles both
// kinds; BOSSMAN_TICKET_COPIES=clone makes new copies clones. Worktrees stay the default until
// every runner image in use understands clones, so rolling an image back can't lose one.
//
// Lessons from cline/kanban: creation is serialised per repo, an existing worktree is never
// recreated because the base moved, uncommitted work survives clean-up as a patch, and only
// the clone itself is provisioned, so ignored local files like .env never leak in.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CHECK_TOOLS, detectChecks, type CarriedResult, type DetectResult, type DiskReport, type MergeResult, type MigrationsResult, type PushResult, type VerifyResult, type WorkspaceDiff, CHECK_QUEUED_MARKER, CHECK_STARTED_MARKER, VERIFY_QUEUE_MAX_MS, VERIFY_TIMEOUT_MS } from "@boss-man/shared";
import { addGitConfig, checkQueueEnv, checkQueueGrant, fencedCommand, fenceProfile, repoGrant } from "./fence.js";
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

/** A ticket's copy that is its own clone (a .git folder), not a worktree of the shared repo (a .git file). */
export const isClone = (dir: string) => statSync(path.join(dir, ".git"), { throwIfNoEntry: false })?.isDirectory() ?? false;

/** The project a copy belongs to, if its link to the shared repo still holds: a worktree's admin folder, or a clone's borrowed objects. */
function copyProject(dir: string): string | null {
  const gitPath = path.join(dir, ".git");
  const read = (f: string) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  const target = isClone(dir) ? read(path.join(gitPath, "objects", "info", "alternates")).split("\n")[0]?.trim() : (read(gitPath) || read(path.join(dir, ".git.bossman-converting"))).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!target || !existsSync(target)) return null;
  return target.match(/repos\/([^/]+)\.git\/(?:worktrees\/|objects$)/)?.[1] ?? null;
}

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
  /** What new instances start with for fenceCloneGit; the test suites that run every operation fenced turn it on. */
  static fenceCloneGitByDefault = false;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly root: string,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    /** check-all.sh's shared queue folder (checkQueueEnv), so the merge check takes turns with agents' checks. */
    private readonly coordDir?: string,
  ) {}

  repoDir = (projectId: string) => path.join(this.root, "repos", `${projectId}.git`);
  ticketDir = (ticketId: string) => path.join(this.root, "tickets", ticketId);
  mergeCheckDir = (ticketId: string) => path.join(this.root, "merge-checks", ticketId);
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

  /**
   * Whether the runner's own git in a ticket's clone runs inside the fence (BOS-323), set from the
   * runner's fence self-test at start-up. A clone's config, hooks and attributes are the agent's to
   * write, and a filter or fsmonitor named there runs whatever -c says, so the daemon's git there is
   * fenced to that clone. It doesn't follow the company's fence setting: a planted config is just as
   * dangerous when the agent itself ran unfenced. Off (no Landlock), it's SAFE_GIT_ENV only, as before.
   */
  fenceCloneGit = Workspaces.fenceCloneGitByDefault;

  /**
   * Where a fenced merge check lives (BOS-323), set at start-up when the runner can fence: its own
   * home, shared by every fenced check (caches, harness state), and the pnpm store it installs from.
   * Null: a check asked to run fenced runs as before, and says so.
   */
  checkFence: { home: string; pnpmStore?: string } | null = null;

  /**
   * opts.repo is the shared repo a clone at opts.cwd borrows from: the one folder outside the clone
   * its fenced git may read. It's the caller's, never read from the clone, whose alternates file the
   * agent can rewrite to point at another project.
   */
  private async git(args: string[], opts: { cwd?: string; env?: Record<string, string>; repo?: string; reads?: string[] } = {}) {
    if (this.fenceCloneGit && opts.cwd && isClone(opts.cwd)) return this.fencedGit(args, opts.cwd, opts.repo, opts.env, opts.reads);
    const env = { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, HTTPS_PROXY: this.baseEnv.HTTPS_PROXY, NO_PROXY: this.baseEnv.NO_PROXY, ...safeGitEnv(opts.env) };
    const { stdout } = await run("git", args, { cwd: opts.cwd, env: env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  /**
   * Git in a clone, fenced: read-write on the clone, a temp folder for this call (its HOME) and the
   * caller's index folder; read-only on the system, the shared repo and any file the caller names. No global or system config,
   * nothing from the daemon's env but PATH, so a program the clone's config names can reach nothing else.
   */
  private async fencedGit(args: string[], dir: string, repo: string | undefined, extra: Record<string, string> = {}, reads: string[] = []) {
    if (!repo) throw new Error(`git in the clone ${dir} was called without its shared repo, so it can't be fenced.`);
    const tmp = this.scratch("git");
    try {
      const readWrite = [tmp, ...(extra.GIT_INDEX_FILE ? [path.dirname(extra.GIT_INDEX_FILE)] : [])];
      const cmd = fencedCommand(fenceProfile({ cwd: dir, home: tmp, tmp, readOnly: [repo, ...reads], readWrite }), "git", args);
      const env = { PATH: this.baseEnv.PATH, HOME: tmp, TMPDIR: tmp, GIT_CONFIG_GLOBAL: "/dev/null", ...safeGitEnv(extra) };
      const { stdout } = await run(cmd.bin, cmd.args, { cwd: dir, env: env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
      return stdout.trim();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** A new folder of the runner's own under tmp/, for one operation (housekeeping sweeps any left behind). */
  private scratch(name: string) {
    mkdirSync(path.join(this.root, "tmp"), { recursive: true });
    return mkdtempSync(path.join(this.root, "tmp", `${name}-`));
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

  /** What a new copy is made as (see the top of this file). */
  private newCopiesAreClones = () => this.baseEnv.BOSSMAN_TICKET_COPIES === "clone";

  /**
   * An empty clone of the shared repo at tmp, with nothing checked out: it borrows the shared
   * repo's objects (no copy of history) and gets origin's branches and tags as they were last
   * fetched, so origin/<default> is current without a network call.
   */
  private async initClone(repo: string, tmp: string) {
    // Clones borrow objects the shared repo might otherwise prune once nothing there points at them.
    await this.git(["config", "gc.pruneExpire", "never"], { cwd: repo });
    const url = await this.git(["config", "--get", "remote.origin.url"], { cwd: repo });
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(path.dirname(tmp), { recursive: true });
    await this.git(["init", "--quiet", tmp]);
    writeFileSync(path.join(tmp, ".git", "objects", "info", "alternates"), `${path.join(repo, "objects")}\n`);
    await this.git(["remote", "add", "origin", url], { cwd: tmp, repo });
    // Other tickets' branches, read-only: `git fetch shared` then e.g. `git merge shared/bossman/<ticket>`.
    await this.git(["remote", "add", "shared", repo], { cwd: tmp, repo });
    await this.git(["config", "remote.shared.fetch", "+refs/heads/bossman/*:refs/remotes/shared/bossman/*"], { cwd: tmp, repo });
    await this.git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", repo, "+refs/remotes/origin/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"], { cwd: tmp, repo });
  }

  /** Points a clone's HEAD at commit: on branch, or detached when branch is null. Nothing is checked out. */
  private async setHead(repo: string, dir: string, commit: string, branch: string | null) {
    if (!branch) return void (await this.git(["update-ref", "--no-deref", "HEAD", commit], { cwd: dir, repo }));
    await this.git(["update-ref", `refs/heads/${branch}`, commit], { cwd: dir, repo });
    await this.git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], { cwd: dir, repo });
  }

  /** Where a copy is built before it's moved into place, so a half-made copy is never taken for one. */
  private buildDir = (dir: string) => path.join(path.dirname(dir), `.${path.basename(dir)}.new`);

  /** A new copy of the shared repo at commit, as a clone: on branch, or detached when branch is null. */
  private async makeClone(repo: string, dir: string, commit: string, branch: string | null) {
    const tmp = this.buildDir(dir);
    await this.initClone(repo, tmp);
    await this.setHead(repo, tmp, commit, branch);
    await this.git(["reset", "--hard", "--quiet"], { cwd: tmp, repo });
    renameSync(tmp, dir);
  }

  /**
   * Turns a ticket's worktree into its own clone in place, keeping every file: committed,
   * uncommitted, untracked and ignored (installed packages too). Only the .git file is swapped for
   * a clone's .git folder and the index rebuilt from HEAD, so staged changes become unstaged. The
   * old .git file is kept aside until the end; a conversion cut short is finished (or undone, if
   * the new .git never arrived) next time. Callers hold the repo lock.
   */
  private async convertToClone(repo: string, dir: string) {
    const gitPath = path.join(dir, ".git");
    const aside = path.join(dir, ".git.bossman-converting");
    if (existsSync(aside) && !existsSync(gitPath)) renameSync(aside, gitPath);
    if (!isClone(dir)) {
      const admin = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!admin || path.dirname(path.resolve(dir, admin)) !== path.join(repo, "worktrees")) throw new Error(`${dir} isn't a worktree of ${repo}.`);
      const head = await this.git(["rev-parse", "HEAD"], { cwd: dir });
      const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: dir }).catch(() => null);
      const tmp = this.buildDir(dir);
      await this.initClone(repo, tmp);
      await this.setHead(repo, tmp, head, branch);
      // Locked, so a worktree prune can't drop its admin folder while the .git file is aside.
      await this.gitCode(["worktree", "lock", "--reason", "turning into a clone (BOS-323)", dir], { cwd: repo });
      renameSync(gitPath, aside);
      renameSync(path.join(tmp, ".git"), gitPath);
      rmSync(tmp, { recursive: true, force: true });
    }
    if (!existsSync(aside)) return;
    await this.git(["reset", "--quiet"], { cwd: dir, repo });
    const admin = readFileSync(aside, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (admin && path.dirname(path.resolve(dir, admin)) === path.join(repo, "worktrees")) rmSync(path.resolve(dir, admin), { recursive: true, force: true });
    rmSync(aside);
  }

  /** A new copy for a ticket: a clone or a worktree, as configured. */
  private async addCopy(repo: string, dir: string, commit: string, branch: string | null, newBranch = false) {
    if (this.newCopiesAreClones()) return this.makeClone(repo, dir, commit, branch);
    if (!branch) return void (await this.git(["worktree", "add", "--quiet", "--detach", dir, commit], { cwd: repo }));
    await this.git(["worktree", "add", "--quiet", ...(newBranch ? ["-b", branch, dir, commit] : [dir, branch])], { cwd: repo });
  }

  /**
   * Brings a clone's work into the shared repo: its branch, its turn checkpoints and its review
   * snapshot, and only this ticket's, whatever else the clone holds. Merges, pushes, other tickets
   * and the run view read them there. Callers hold the repo lock.
   */
  private async syncBranch(repo: string, dir: string, ticketId: string) {
    const branch = `refs/heads/${branchFor(ticketId)}`;
    const checkpoints = `${this.checkpointPrefix(ticketId)}*`;
    const review = this.reviewRef(ticketId);
    const has = async (ref: string) => (await this.gitCode(["rev-parse", "--verify", "--quiet", ref], { cwd: dir, repo })).code === 0;
    const specs = [`+${branch}:${branch}`, `+${checkpoints}:${checkpoints}`, ...((await has(review)) ? [`+${review}:${review}`] : [])];
    // The clone's side of the fetch (upload-pack) reads the clone's config, so it's fenced too: it
    // may read the clone and the shared repo and write only its own temp folder. The shared repo's
    // side checks every object it takes.
    const tmp = this.fenceCloneGit ? this.scratch("upload-pack") : null;
    try {
      const uploadPack = tmp
        ? ["--upload-pack", shellQuote(fencedCommand(fenceProfile({ cwd: tmp, home: tmp, tmp, readOnly: [dir, repo] }), "env", [`HOME=${tmp}`, `TMPDIR=${tmp}`, "GIT_CONFIG_GLOBAL=/dev/null", "git", "upload-pack"]))]
        : [];
      const r = await this.gitCode(["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", ...uploadPack, dir, ...specs], { cwd: repo });
      if (r.code !== 0) throw new Error(`Couldn't bring ticket ${ticketId}'s branch over from its copy: ${r.stderr.slice(0, 500)}`);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** In a clone, the review snapshot's ref, so it can be fetched into the shared repo. */
  private reviewRef = (ticketId: string) => `refs/bossman/review-copy/${ticketId}`;

  /** The ticket's copy, created on first use and reused (never recreated) after that. */
  async ensure(spec: WorkspaceSpec, secrets: Record<string, string | undefined> = {}): Promise<WorkspaceInfo> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      const dir = this.ticketDir(spec.ticketId);
      const branch = branchFor(spec.ticketId);
      const baseKey = `bossman.ticket-${spec.ticketId}.base`;

      await this.cloneIfMissing(spec, auth);

      // A conversion cut short leaves the old .git aside; it's finished or undone below.
      if (existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, ".git.bossman-converting"))) {
        if (!this.newCopiesAreClones() && !existsSync(path.join(dir, ".git"))) {
          renameSync(path.join(dir, ".git.bossman-converting"), path.join(dir, ".git"));
          await this.gitCode(["worktree", "unlock", dir], { cwd: repo });
        }
        if (this.newCopiesAreClones() || isClone(dir)) await this.convertToClone(repo, dir);
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
        await this.addCopy(repo, dir, await this.git(["rev-parse", `refs/heads/${branch}`], { cwd: repo }), branch);
      } else {
        baseCommit = await this.git(["rev-parse", "--verify", `${spec.baseRef.match(/^[0-9a-f]{7,40}$/) ? spec.baseRef : `refs/remotes/origin/${spec.baseRef}`}^{commit}`], { cwd: repo });
        // The shared repo has the branch from the start, whichever kind of copy works on it.
        if (this.newCopiesAreClones()) await this.git(["update-ref", `refs/heads/${branch}`, baseCommit], { cwd: repo });
        await this.addCopy(repo, dir, baseCommit, branch, true);
        await this.git(["config", baseKey, baseCommit], { cwd: repo });
      }

      let restoredPatch = false;
      const patch = this.patchFile(spec.ticketId);
      if (existsSync(patch)) {
        await this.git(["apply", "--whitespace=nowarn", patch], { cwd: dir, repo, reads: [patch] });
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
      await this.addCopy(repo, dir, await this.git(["rev-parse", `refs/heads/${branch}`], { cwd: repo }), branch);
      const patch = this.patchFile(spec.ticketId);
      if (existsSync(patch)) {
        await this.git(["apply", "--whitespace=nowarn", patch], { cwd: dir, repo, reads: [patch] });
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
      if (existsSync(path.join(dev, ".git"))) {
        commit = await this.snapshot(repo, dev);
        // A clone's snapshot is only in its own objects: the shared repo, which the review copy reads, needs it too.
        if (isClone(dev)) {
          await this.git(["update-ref", this.reviewRef(spec.ticketId), commit], { cwd: dev, repo });
          await this.syncBranch(repo, dev, spec.ticketId);
        }
      } else {
        await this.git(["fetch", "--quiet", "origin"], { cwd: repo, env: auth });
        const branch = branchFor(spec.ticketId);
        commit = await this.git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd: repo }).catch(() =>
          this.git(["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], { cwd: repo }).catch(() => {
            throw new Error("That ticket has no work on this runner to review.");
          }),
        );
      }
      if (existsSync(path.join(dir, ".git"))) {
        await this.git(["checkout", "--quiet", "--force", "--detach", commit], { cwd: dir, repo });
        await this.git(["clean", "-fdq"], { cwd: dir, repo });
      } else {
        await this.git(["worktree", "prune"], { cwd: repo });
        mkdirSync(path.dirname(dir), { recursive: true });
        await this.addCopy(repo, dir, commit, null);
      }
      return { path: dir, commit };
    });
  }

  /** The worktree as it is now, as a commit no ref points at; its branch, index and files are untouched. */
  private async snapshot(repo: string, dir: string): Promise<string> {
    // Each index in a folder of its own: a fenced git may write its index's folder, and no other.
    const scratch = this.scratch(`${path.basename(dir)}.review`);
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    try {
      await this.git(["read-tree", "HEAD"], { cwd: dir, env, repo });
      await this.git(["add", "-A"], { cwd: dir, env, repo });
      const tree = await this.git(["write-tree"], { cwd: dir, env, repo });
      const who = this.authorEnv();
      return await this.git(["commit-tree", tree, "-p", "HEAD", "-m", "Boss Man review copy"], { cwd: dir, env: who, repo });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
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
      const review = this.reviewDir(spec.ticketId);
      if (isClone(review)) rmSync(review, { recursive: true, force: true });
      else if (existsSync(path.join(review, ".git"))) await this.git(["worktree", "remove", "--force", review], { cwd: repo });
      await this.gitCode(["update-ref", "-d", this.reviewRef(spec.ticketId)], { cwd: repo });
      if (!existsSync(path.join(dir, ".git"))) return { savedPatch: false };
      const clone = isClone(dir);
      // The branch is all that's kept of a clone, so it must reach the shared repo before the clone goes.
      if (clone) await this.syncBranch(repo, dir, spec.ticketId);
      await this.git(["add", "-A"], { cwd: dir, repo });
      const diff = await this.git(["diff", "--cached", "--binary", "HEAD"], { cwd: dir, repo });
      let savedPatch = false;
      if (diff) {
        mkdirSync(path.dirname(this.patchFile(spec.ticketId)), { recursive: true });
        writeFileSync(this.patchFile(spec.ticketId), `${diff}\n`);
        savedPatch = true;
      }
      if (clone) rmSync(dir, { recursive: true, force: true });
      else await this.git(["worktree", "remove", "--force", dir], { cwd: repo });
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
    const head = await this.git(["rev-parse", "HEAD"], { cwd: dir, repo });
    const log = await this.git(["log", "--format=%H%x09%s", `${baseCommit}..HEAD`], { cwd: dir, repo });
    const commits = log ? log.split("\n").map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })) : [];
    const scratch = this.scratch(`${spec.ticketId}.diff`);
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    try {
      await this.git(["read-tree", "HEAD"], { cwd: dir, env, repo });
      await this.git(["add", "-A"], { cwd: dir, env, repo });
      const numstat = await this.git(["diff", "--cached", "--numstat", baseCommit], { cwd: dir, env, repo });
      const files = numstat
        ? numstat.split("\n").map((l) => {
            const [a, r, ...p] = l.split("\t");
            return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r) };
          })
        : [];
      const full = await this.git(["diff", "--cached", baseCommit], { cwd: dir, env, repo });
      const truncated = Buffer.byteLength(full) > maxBytes;
      return { baseCommit, head, commits, files, diff: truncated ? full.slice(0, maxBytes) : full, truncated };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
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
    const made = await this.recordCheckpoint(spec, dir, label, by);
    // Before and after every turn, recorded or not (a commit can leave the files unchanged), so the
    // shared repo is never more than a turn behind a clone's branch.
    if (isClone(dir)) await this.withRepoLock(spec.projectId, () => this.syncBranch(this.repoDir(spec.projectId), dir, spec.ticketId));
    return made;
  }

  private async recordCheckpoint(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, dir: string, label: string, by?: string) {
    const repo = this.repoDir(spec.projectId);
    const scratch = this.scratch(`${spec.ticketId}.checkpoint`);
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    try {
      await this.git(["read-tree", "HEAD"], { cwd: dir, env, repo });
      await this.git(["add", "-A"], { cwd: dir, env, repo });
      const tree = await this.git(["write-tree"], { cwd: dir, env, repo });
      const list = await this.checkpoints(spec.projectId, spec.ticketId);
      const last = list[list.length - 1];
      const parent = last?.commit ?? (await this.git(["rev-parse", "HEAD"], { cwd: dir, repo }));
      if ((await this.git(["rev-parse", `${parent}^{tree}`], { cwd: dir, repo })) === tree) return null;
      const commit = await this.git(["commit-tree", tree, "-p", parent, "-m", `Boss Man checkpoint: ${label}`], { cwd: dir, env: this.authorEnv(by), repo });
      const turn = (last?.n ?? 0) + 1;
      await this.git(["update-ref", `${this.checkpointPrefix(spec.ticketId)}${String(turn).padStart(6, "0")}`, commit], { cwd: dir, repo });
      const files = await this.git(["diff", "--name-only", parent, commit], { cwd: dir, repo });
      return { turn, commit, files: files ? files.split("\n").length : 0 };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
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
  private async gitCode(args: string[], opts: { cwd?: string; env?: Record<string, string>; repo?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
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
      const dir = this.ticketDir(spec.ticketId);
      if (isClone(dir)) await this.syncBranch(repo, dir, spec.ticketId);
      return checkMigrations((args) => this.gitCode(args, { cwd: repo, env: auth }), repo, { branch: branchFor(spec.ticketId), target, others });
    });
  }

  /**
   * Runs the ticket's check (e.g. "pnpm test") in its worktree (R47). Output is kept to the
   * last 8 KB. It runs without the company's secrets: a check shouldn't need them.
   */
  async verify(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, command: string, timeoutMs = VERIFY_TIMEOUT_MS, queueMaxMs = VERIFY_QUEUE_MAX_MS, fence = false): Promise<VerifyResult> {
    return this.runCheck(await this.reopen(spec), command, timeoutMs, queueMaxMs, fence ? spec.projectId : null);
  }

  /** One check command in a folder: its own process group, output kept to the last 8 KB. A project id asks for the fence. */
  private runCheck(dir: string, command: string, timeoutMs: number, queueMaxMs = VERIFY_QUEUE_MAX_MS, fenceProject: string | null = null): Promise<VerifyResult> {
    const fence = fenceProject !== null;
    const started = Date.now();
    // BOSSMAN_MERGE_CHECK: scripts/check-all.sh lets the merge check take the shared lock ahead of agents' hand-run checks.
    let env: NodeJS.ProcessEnv = { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, CI: "1", BOSSMAN_MERGE_CHECK: "1", ...(this.coordDir ? checkQueueEnv(this.coordDir) : {}) };
    let launch = { bin: "sh", args: ["-c", command] };
    let tmp: string | null = null;
    if (fence && this.checkFence) {
      const set = this.fenceCheck(fenceProject ?? "", dir, env, launch);
      ({ env, launch, tmp } = set);
    }
    const fenced = fence ? { fenced: tmp !== null } : {};
    return new Promise<VerifyResult>((resolve) => {
      // Own process group, so a timeout can take down pnpm, tsc, vitest and their workers, not just the shell.
      const child = spawn(launch.bin, launch.args, { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
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
        if (tmp) rmSync(tmp, { recursive: true, force: true });
        resolve({ ok: !timedOut && exitCode === 0, exitCode: timedOut ? null : exitCode, timedOut, output: tail, ms: Date.now() - started, ...fenced });
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
   * The merge check inside the fence (BOS-323), with what an agent's session gets for the same copy:
   * read-write on the ticket's copy, the check's own home, a temp folder for this check, the pnpm
   * store and check-all's queue; read-only on the system, the runner's install, the global npm tools,
   * the browsers, check-all's results and the shared repo (for a worktree, what a commit writes too).
   * Nothing of the daemon's: not its HOME, its token or other tickets' copies.
   */
  private fenceCheck(projectId: string, dir: string, env: NodeJS.ProcessEnv, launch: { bin: string; args: string[] }) {
    const { home, pnpmStore } = this.checkFence!;
    mkdirSync(path.join(home, "tmp"), { recursive: true });
    const tmp = mkdtempSync(path.join(home, "tmp", "check-"));
    const out: NodeJS.ProcessEnv = { ...env, HOME: home, TMPDIR: tmp };
    const readWrite: string[] = [];
    const readOnly = [this.baseEnv.NPM_CONFIG_PREFIX, this.baseEnv.PLAYWRIGHT_BROWSERS_PATH].filter((p): p is string => !!p);
    if (pnpmStore) {
      mkdirSync(pnpmStore, { recursive: true });
      // pnpm keeps the store's location in HOME's config; without this it starts a new store in the copy.
      out.npm_config_store_dir = pnpmStore;
      readWrite.push(pnpmStore);
    }
    if (this.baseEnv.NPM_CONFIG_PREFIX) out.NPM_CONFIG_PREFIX = this.baseEnv.NPM_CONFIG_PREFIX;
    if (this.baseEnv.PLAYWRIGHT_BROWSERS_PATH) out.PLAYWRIGHT_BROWSERS_PATH = this.baseEnv.PLAYWRIGHT_BROWSERS_PATH;
    if (this.coordDir) {
      const grant = checkQueueGrant(this.coordDir);
      readWrite.push(grant.readWrite);
      readOnly.push(grant.readOnly);
    }
    // A worktree's shared repo has a read-only root, where auto-gc would write.
    addGitConfig(out, "gc.auto", "0");
    const rules = fenceProfile({ cwd: dir, home, tmp, repo: repoGrant(this.repoDir(projectId), dir), readOnly, readWrite });
    return { env: out, launch: fencedCommand(rules, launch.bin, launch.args), tmp };
  }

  /**
   * Merges the ticket's branch into a named target without any working tree (R46). The merge is
   * tried with merge-tree (exit codes, never output text); a clean result becomes a merge
   * commit pushed to the target. Nothing is cleaned or reset, so files outside the ticket's
   * worktree can't be touched. If the target moved meanwhile, the push is rejected and the
   * merge is tried once more.
   */
  async merge(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, message: string, secrets: Record<string, string | undefined> = {}, checks: { commands: string[]; timeoutMs?: number } | null = null): Promise<MergeResult> {
    if (checks?.commands.length) return this.mergeChecked(spec, target, message, secrets, checks.commands, checks.timeoutMs ?? VERIFY_TIMEOUT_MS);
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      const dir = this.ticketDir(spec.ticketId);
      const branch = `refs/heads/${branchFor(spec.ticketId)}`;
      if (existsSync(path.join(dir, ".git"))) {
        const dirty = await this.git(["status", "--porcelain"], { cwd: dir, repo });
        if (dirty) return { status: "uncommitted", files: dirty.split("\n").map((l) => l.slice(3)) };
        if (isClone(dir)) await this.syncBranch(repo, dir, spec.ticketId);
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

  /**
   * Merges like merge(), but checks the merge commit itself before pushing it (BOS-313, F6).
   * Two branches that each pass alone can break the target together, so the check runs on a
   * temporary detached worktree of the commit that will be pushed, and exactly that commit is
   * pushed. The repo lock is held only to build and to push, not during the check. If the target
   * moved meanwhile, the merge is built again: an unchanged merged tree keeps the earlier check,
   * a changed one is checked again (three checks at most, then main_moved so the caller retries).
   */
  private async mergeChecked(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, message: string, secrets: Record<string, string | undefined>, commands: string[], timeoutMs: number): Promise<MergeResult> {
    const auth = gitAuthEnv(secrets);
    const repo = this.repoDir(spec.projectId);
    const branch = `refs/heads/${branchFor(spec.ticketId)}`;
    const base = this.mergeCheckDir(spec.ticketId);
    // A leftover from a run that died is cleared once, up front. Each round then gets its own folder, so a stray
    // process from an earlier round can never write into the tree a later round checks.
    rmSync(base, { recursive: true, force: true });
    let dir = base;
    let checked: { commit: string; tree: string; targetSha: string; branchSha: string } | null = null;
    let checkedMs = 0;
    let checks = 0;
    // A push that failed against this target sha. If the target is still there next round, the push was refused for good.
    let refused: { targetSha: string; stderr: string } | null = null;
    for (let round = 0; round < 8; round++) {
      // Build the merge commit under the lock; push it at once if its tree is already checked.
      const built = await this.withRepoLock(spec.projectId, async (): Promise<MergeResult | { status: "check"; commit: string; tree: string; targetSha: string; branchSha: string }> => {
        const ticketDir = this.ticketDir(spec.ticketId);
        if (existsSync(path.join(ticketDir, ".git"))) {
          const dirty = await this.git(["status", "--porcelain"], { cwd: ticketDir });
          if (dirty) return { status: "uncommitted", files: dirty.split("\n").map((l) => l.slice(3)) };
        }
        const tried = await this.tryMerge(repo, branch, target, auth);
        if (tried.status !== "clean") return tried;
        if (refused && refused.targetSha === tried.targetSha) throw new Error(`Couldn't push the merge to ${target}: ${refused.stderr.slice(0, 500)}`);
        const commit = await this.git(["commit-tree", tried.tree, "-p", tried.targetSha, "-p", tried.branchSha, "-m", message], { cwd: repo, env: this.authorEnv() });
        if (!checked || tried.tree !== checked.tree) {
          dir = path.join(base, `${round}-${Date.now().toString(36)}`);
          await this.git(["worktree", "prune"], { cwd: repo });
          mkdirSync(base, { recursive: true });
          await this.git(["worktree", "add", "--quiet", "--detach", dir, commit], { cwd: repo });
          return { status: "check", commit, tree: tried.tree, targetSha: tried.targetSha, branchSha: tried.branchSha };
        }
        // Same parents as the checked commit: push that very commit. Otherwise the same tree on new parents;
        // the record still names the commit the check really ran on.
        const same = checked.targetSha === tried.targetSha && checked.branchSha === tried.branchSha;
        const toPush = same ? checked.commit : commit;
        const pushed = await this.gitCode(["push", "--quiet", "origin", `${toPush}:refs/heads/${target}`], { cwd: repo, env: auth });
        if (pushed.code === 0) return { status: "merged", commit: toPush, checked: { sha: checked.commit, tree: tried.tree, ms: checkedMs } };
        // Rejected: either the target moved again, or the push is refused for good (protected branch, bad token,
        // hook). The next round tells them apart: if the target sha is unchanged, it throws git's message.
        refused = { targetSha: tried.targetSha, stderr: pushed.stderr };
        return { status: "check", commit: "", tree: "", targetSha: "", branchSha: "" };
      });
      if (built.status !== "check") return built;
      if (!built.commit) continue;
      if (checks >= 3) {
        await this.dropMergeCheck(spec.projectId, dir, base);
        return { status: "main_moved" };
      }
      checks++;
      try {
        for (const command of commands) {
          const result = await this.runCheck(dir, command, timeoutMs);
          checkedMs += result.ms;
          if (!result.ok) return { status: "check_failed", command, result };
        }
      } finally {
        await this.dropMergeCheck(spec.projectId, dir, base);
      }
      checked = { commit: built.commit, tree: built.tree, targetSha: built.targetSha, branchSha: built.branchSha };
    }
    // Main kept moving: nothing was pushed, so the caller retries like a lock wait.
    return { status: "main_moved" };
  }

  private async dropMergeCheck(projectId: string, dir: string, base: string) {
    const repo = this.repoDir(projectId);
    await this.withRepoLock(projectId, async () => {
      await this.git(["worktree", "remove", "--force", dir], { cwd: repo }).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      try { rmdirSync(base); } catch { /* not empty or already gone */ }
      await this.git(["worktree", "prune"], { cwd: repo }).catch(() => undefined);
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
      const dir = this.ticketDir(spec.ticketId);
      if (isClone(dir)) await this.syncBranch(repo, dir, spec.ticketId);
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
        const dirty = await this.git(["status", "--porcelain"], { cwd: dir, repo });
        if (dirty) return { status: "uncommitted", files: dirty.split("\n").map((l) => l.slice(3)) };
        if (isClone(dir)) await this.syncBranch(repo, dir, spec.ticketId);
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
   * list is pruned of entries whose folder has gone, ticket folders no longer linked to a
   * shared repo are removed (only once they're 10 minutes old, so a copy being created isn't
   * caught), and stray temp files go. Linked copies are left alone: the server decides which
   * tickets are finished and releases those, keeping their branches.
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
      const projectId = copyProject(dir);
      if (!projectId) {
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
      if (!copyProject(dir) && now - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? now) > 10 * 60_000) {
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

/** One command line for sh, each word single-quoted (git runs --upload-pack through the shell). */
const shellQuote = (c: { bin: string; args: string[] }) => [c.bin, ...c.args].map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(" ");
