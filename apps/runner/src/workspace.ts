// Git workspaces (R38): one copy per ticket, on its own branch, from a pinned base.
//
// Layout under the workspaces volume:
//   repos/<projectId>.git     a bare clone per project, shared by its tickets
//   tickets/<ticketId>        the ticket's copy, on branch bossman/<ticket>
//   reviews/<ticketId>        a reviewer's own detached copy of that work
//   patches/<ticketId>.patch  uncommitted work saved when a copy is released
//   scratch/<ticketId>        a ticket's kept proofs and check logs (BOSSMAN_SCRATCH), unlike /tmp
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
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { CHECK_TOOLS, DEPLOY_REF, prepareFullLog, FULL_LOG_MAX, FULL_LOG_HEAD, deployTagNameProblem, detectChecks, type ResolveResult, type TagResult, type CarriedResult, type DetectResult, type DiskReport, type MergeResult, type MigrationsResult, type PushResult, type Uncommitted, type VerifyResult, type WorkspaceDiff, CHECK_QUEUED_MARKER, CHECK_STARTED_MARKER, RELEASED_SCRATCH_KEEP_MS, SCRATCH_KEEP_MS, VERIFY_QUEUE_MAX_MS, VERIFY_TIMEOUT_MS } from "@boss-man/shared";
import { addGitConfig, checkQueueEnv, checkQueueGrant, fencedCommand, fenceProfile, repoGrant, shortTmpName, type FenceLevel } from "./fence.js";
import { GitConfigGuard } from "./git-config-guard.js";
import { withoutCoreDumps } from "./no-core.js";
import { checkMigrations, journalAt, journalProblems, rebaseMigrations } from "./migrations.js";
import { checkSignoffCovers, type SignoffCover } from "./signoff-covers.js";

const run = promisify(execFile);

/**
 * The worktree admin folder a .git pointer names, but only if it sits directly in <repo>/worktrees
 * and its own gitdir file points back at <dir>/.git. A pointer the agent wrote at another ticket's
 * admin folder fails the second test (BOS-323, Jane's finding).
 */
function ownAdminDir(repo: string, dir: string, pointer: string | undefined): string | null {
  if (!pointer) return null;
  const admin = path.resolve(dir, pointer);
  if (path.dirname(admin) !== path.join(repo, "worktrees")) return null;
  try {
    const back = readFileSync(path.join(admin, "gitdir"), "utf8").trim();
    return path.resolve(back) === path.join(path.resolve(dir), ".git") ? admin : null;
  } catch {
    return null;
  }
}
const VERIFY_KILL_GRACE_MS = 2000;
/** A review copy's install (BOS-693): seconds from a warm store; a cold one on a slow link can take a few minutes. */
export const REVIEW_INSTALL_TIMEOUT_MS = 5 * 60_000;
/**
 * The run-start refresh's upstream fetch (BOS-853) holds the project's repo lock, so every other run start and merge
 * for the project waits behind it. A hung connection (a stalled TCP link, dropped packets, a slow host) is cut off
 * here, git's helpers and all, and the run starts with the copy it has.
 */
export const RUN_START_FETCH_TIMEOUT_MS = 60_000;
/**
 * Every other fetch from upstream (BOS-893): making a ticket's copy, a reviewer's copy, a review's base and the merge
 * gate's migration check. A stalled connection would otherwise leave that step hanging until the run is killed, with
 * nothing saying it was git. The fetch runs in its own process group, so its transport helper goes with it too.
 */
export const FETCH_TIMEOUT_MS = 60_000;

/** Runs a command in its own process group, killed whole at the timeout; output kept to the last 4 KB. Never rejects on exit. */
function runGroup(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      output = (output + String(d)).slice(-4096);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // group already gone
      }
    };
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      hard = setTimeout(() => kill("SIGKILL"), VERIFY_KILL_GRACE_MS);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      clearTimeout(hard);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(hard);
      resolve({ code, timedOut, output: output.trim() });
    });
  });
}

export type WorkspaceSpec = { projectId: string; ticketId: string; repoUrl: string; baseRef: string; review?: boolean };
export type WorkspaceInfo = { path: string; branch: string; baseCommit: string; created: boolean; restoredPatch: boolean };
/** A server-queued merge's phase (BOS-316); `base` / `expectBase` are the merge train's (BOS-1366). */
export type MergePhase = { phase: "prepare"; base?: string } | { phase: "finish"; commit: string; tree: string; expectBase?: string };

/**
 * Git credentials from the run's granted secrets, passed through the environment only.
 * Nothing is written to a URL or to git config on disk. GIT_TOKEN is sent as HTTP Basic
 * auth (GitHub, GitLab and Gitea accept a token this way); GIT_USERNAME defaults to
 * x-access-token. For the daemon's own git only: an agent's session never gets it (BOS-322).
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

/**
 * Where a session's push to the upstream address is sent instead (BOS-853): a path that is no repo, so the push fails
 * at once, with no network call and no login asked for. Boss Man merges a ticket's branch; copies never push.
 */
export const NO_PUSH_URL = "/bossman/copies-never-push--Boss-Man-merges-the-branch";

/** Whether an address carries a user or password (https://user:token@host/...), which must never reach a session. */
export function hasCredential(url: string): boolean {
  try {
    const u = new URL(url);
    return !!(u.username || u.password) && u.protocol !== "ssh:";
  } catch {
    return false;
  }
}

const firstLine = (err: unknown) => String((err as { stderr?: string })?.stderr || (err as Error)?.message || err).trim().split("\n")[0]!.slice(0, 300);

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

/** The repo's lock stayed taken for the whole wait: nothing is wrong with the repo, so the caller can try again. */
export class RepoLockTimeout extends Error {
  constructor(projectId: string) {
    super(`Timed out waiting for the lock on ${projectId}.`);
    this.name = "RepoLockTimeout";
  }
}

/**
 * Settings for every git call the runner makes itself. A repo's own config can name programs (a hook
 * folder, a filesystem monitor, a credential helper, a signing program), so a shared repo could
 * otherwise run code inside the daemon. GIT_CONFIG_* sits above the repo's config file, so it wins.
 * The main defence is GitConfigGuard (BOS-332), which keeps the repo config to an allowlist; these
 * single-name overrides are the second layer, for the moment between its check and the git run.
 * No global config (an agent without the fence can write the daemon's ~/.gitconfig), no system one,
 * and no password prompt program (an empty GIT_ASKPASS beats core.askPass and SSH_ASKPASS).
 */
export const SAFE_GIT_ENV = {
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_CONFIG_KEY_1: "core.fsmonitor",
  GIT_CONFIG_VALUE_1: "false",
  // An empty value clears the list of helpers read so far, and the repo config is read before this.
  GIT_CONFIG_KEY_2: "credential.helper",
  GIT_CONFIG_VALUE_2: "",
  GIT_CONFIG_KEY_3: "commit.gpgSign",
  GIT_CONFIG_VALUE_3: "false",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh",
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

/**
 * The git author and committer for a name. An agent's session gets this in its environment (BOS-255):
 * the worktrees share the repo's own config, where an agent's `git config user.name` lands for every
 * later run, and environment variables beat any config file.
 */
export function gitAuthorEnv(by?: string) {
  const name = by?.trim().slice(0, 200) || "Boss Man";
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: "bossman@localhost", GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: "bossman@localhost" };
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
    /** The pnpm store a check's install uses (BOS-568), so its packages aren't copied into the root disk's HOME; the gate gets its own, outside the fence's grant. */
    private readonly pnpmStore?: string,
    /** Fence for server-queued check jobs (BOS-316, security F1): a job runs a commit nobody has reviewed yet. */
    private readonly jobFence?: { level: FenceLevel; pnpmStore?: string },
  ) {}

  repoDir = (projectId: string) => path.join(this.root, "repos", `${projectId}.git`);
  ticketDir = (ticketId: string) => path.join(this.root, "tickets", ticketId);
  /** A ticket's kept scratch (BOSSMAN_SCRATCH): proofs and check logs that outlive the runner and /tmp. */
  scratchDir = (ticketId: string) => path.join(this.root, "scratch", ticketId);
  mergeCheckDir = (ticketId: string) => path.join(this.root, "merge-checks", ticketId);
  reviewDir = (ticketId: string) => path.join(this.root, "reviews", ticketId);
  patchFile = (ticketId: string) => path.join(this.root, "patches", `${ticketId}.patch`);

  /**
   * Who its commits say made them. The agent's current display name (sent with each run,
   * BOS-265), so a rename shows at once; Boss Man's own commits (checkpoints, a review copy, a
   * merge) are always Boss Man, since they aren't the agent's work.
   */
  private authorEnv(by?: string) {
    return gitAuthorEnv(by);
  }

  /** Keeps each config file the runner's git reads to the allowlist before the call (BOS-332). */
  private guardInstance?: GitConfigGuard;
  private get configGuard() {
    return (this.guardInstance ??= new GitConfigGuard(this.baseEnv));
  }

  /**
   * Whether the runner's own git in a ticket's clone runs inside the fence (BOS-323), set from the
   * runner's fence self-test at start-up. A clone's config, hooks and attributes are the agent's to
   * write, and a filter or fsmonitor named there runs whatever -c says, so the daemon's git there is
   * fenced to that clone. It doesn't follow the company's fence setting: a planted config is just as
   * dangerous when the agent itself ran unfenced. Off (no Landlock), it's SAFE_GIT_ENV only, as before.
   */
  fenceCloneGit = Workspaces.fenceCloneGitByDefault;

  /** How long the run-start refresh's upstream fetch may take (BOS-853); see RUN_START_FETCH_TIMEOUT_MS. */
  runStartFetchTimeoutMs = RUN_START_FETCH_TIMEOUT_MS;

  /** How long every other upstream fetch may take (BOS-893); see FETCH_TIMEOUT_MS. */
  fetchTimeoutMs = FETCH_TIMEOUT_MS;

  /**
   * Where a fenced merge check lives (BOS-323), set at start-up when the runner can fence: its own
   * home, shared by every fenced check (caches, harness state), and the pnpm store it installs from.
   * Null: a check asked to run fenced runs as before, and says so.
   */
  checkFence: { home: string; pnpmStore?: string; tmpRoot?: string } | null = null;

  /**
   * opts.repo is the shared repo a clone at opts.cwd borrows from: the one folder outside the clone
   * its fenced git may read. It's the caller's, never read from the clone, whose alternates file the
   * agent can rewrite to point at another project.
   */
  /**
   * The runner's own git (BOS-332: never discovered from a folder, always told where the repo is, and
   * the config it reads is kept to the allowlist first). Three kinds of call:
   * - `cwd` alone: a bare repo of ours (repos/<id>.git), named with GIT_DIR.
   * - `cwd` + `repo`: inside one of repo's copies. A worktree (a .git file) gets its admin folder found
   *   from the repo's side (wtEnv); a clone (a real .git folder) gets GIT_DIR and GIT_COMMON_DIR both set
   *   to that folder, so a planted .git/commondir can't send git elsewhere, and its own config is checked.
   * - neither: only `init`/`clone`, which make a repo; run from the repos folder, which is no repo at all.
   */
  private async git(args: string[], opts: { cwd?: string; env?: Record<string, string>; repo?: string; reads?: string[]; timeoutMs?: number } = {}) {
    const repo = opts.repo ?? opts.cwd;
    if (repo && !this.isRepoDir(repo)) throw new Error(`The runner's git only runs in one of its own repos, not ${repo} (BOS-332).`);
    let place: Record<string, string>;
    let clone = false;
    if (opts.cwd && opts.repo) {
      const kind = lstatSync(path.join(opts.cwd, ".git"), { throwIfNoEntry: false });
      clone = kind?.isDirectory() ?? false;
      if (clone) {
        const gitDir = path.join(path.resolve(opts.cwd), ".git");
        // As in worktreeAdminFor: git 2.39's ref store reads a commondir file even with GIT_COMMON_DIR set,
        // so one planted in a clone (which never has one) would move HEAD and the refs to the agent's repo. Refused, not removed.
        if (lstatSync(path.join(gitDir, "commondir"), { throwIfNoEntry: false })) throw new Error(`${opts.cwd} isn't a clone the runner can confirm: its .git has a commondir that points elsewhere (BOS-332).`);
        await this.configGuard.check(path.join(gitDir, "config"));
        place = { GIT_DIR: gitDir, GIT_COMMON_DIR: gitDir, GIT_WORK_TREE: path.resolve(opts.cwd) };
      } else {
        await this.configGuard.check(path.join(opts.repo, "config"));
        place = this.wtEnv(opts.repo, opts.cwd);
      }
    } else if (opts.cwd) {
      await this.configGuard.check(path.join(opts.cwd, "config"));
      place = { GIT_DIR: opts.cwd };
    } else {
      mkdirSync(this.reposRoot(), { recursive: true });
      place = {};
    }
    const extra = { ...opts.env, ...place };
    // A clone is always fenced. So is any ticket folder of a runner that makes clones, whatever its .git now is: an agent that swaps the clone's .git for a pointer at a git dir it controls would otherwise move the runner's git out of the fence.
    if (this.fenceCloneGit && opts.cwd && opts.repo && (clone || this.newCopiesAreClones())) return this.fencedGit(args, opts.cwd, opts.repo, extra, opts.reads);
    const env = { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, HTTPS_PROXY: this.baseEnv.HTTPS_PROXY, NO_PROXY: this.baseEnv.NO_PROXY, ...safeGitEnv(extra) };
    if (opts.timeoutMs !== undefined) {
      // Its own process group, so a timeout also ends git's transport helper (git-remote-https, ssh), not just git.
      const r = await runGroup("git", args, opts.cwd ?? this.reposRoot(), env as NodeJS.ProcessEnv, opts.timeoutMs);
      if (r.timedOut) throw new Error(`git ${args[0]} timed out after ${Math.round(opts.timeoutMs / 1000)} s and was stopped`);
      if (r.code !== 0) throw new Error(`git ${args[0]} failed (exit ${r.code}): ${r.output.split("\n").filter(Boolean).pop() ?? ""}`);
      return r.output;
    }
    const { stdout } = await run("git", args, { cwd: opts.cwd ?? this.reposRoot(), env: env as NodeJS.ProcessEnv, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  private reposRoot = () => path.join(this.root, "repos");
  private isRepoDir = (p: string) => path.dirname(path.resolve(p)) === path.resolve(this.reposRoot()) && p.endsWith(".git");

  /**
   * git inside one of a repo's worktrees (a ticket folder, a review copy, a merge-check folder), told
   * exactly where everything is (BOS-332): GIT_DIR is the worktree's admin folder in our repo, found
   * from the repo's side; GIT_COMMON_DIR is the repo; GIT_WORK_TREE the folder. So the folder's .git
   * file and the admin folder's commondir, which an agent can rewrite to point at a repo it made
   * (with any config it likes), are never read, and the config is always the checked one.
   */
  private wtEnv(repo: string, dir: string): Record<string, string> {
    return { GIT_DIR: this.worktreeAdminFor(repo, dir), GIT_COMMON_DIR: repo, GIT_WORK_TREE: path.resolve(dir) };
  }

  /**
   * The admin folder of the worktree at `dir`: the one folder under <repo>/worktrees whose gitdir file names
   * <dir>/.git. Unlike fence.ts's worktreeAdmin, the folder's own .git file isn't trusted: the agent working
   * there can rewrite it. The admin folder is the daemon's choice of path; an agent can only break its own
   * link (its git and ours then stop working there, with this error), never point us at another repo.
   */
  private worktreeAdminFor(repo: string, dir: string): string {
    const dotGit = path.join(path.resolve(dir), ".git");
    const root = path.join(repo, "worktrees");
    const names = existsSync(root) ? readdirSync(root) : [];
    const found = names.filter((n) => {
      const admin = path.join(root, n);
      try {
        return lstatSync(admin).isDirectory() && path.resolve(admin, readFileSync(path.join(admin, "gitdir"), "utf8").trim()) === dotGit;
      } catch {
        return false;
      }
    });
    if (found.length !== 1) throw new Error(`${dir} isn't a worktree of ${repo} that the runner can confirm (BOS-332).`);
    const admin = path.join(root, found[0]!);
    // GIT_COMMON_DIR covers the config and objects, but git 2.39's ref store still reads the admin folder's
    // commondir file, so a rewritten one would make refs (HEAD's branch) resolve in the agent's own repo.
    // A plain file leading back to this repo, or the call is refused; it is never repaired (it could be a symlink).
    let common: string | null = null;
    try {
      if (lstatSync(path.join(admin, "commondir")).isFile()) common = path.resolve(admin, readFileSync(path.join(admin, "commondir"), "utf8").trim());
    } catch {
      common = null;
    }
    if (common !== path.resolve(repo)) throw new Error(`${dir} isn't a worktree of ${repo} that the runner can confirm: its admin folder points elsewhere (BOS-332).`);
    return admin;
  }

  /** Where a repo's fetches and pushes go: the address the runner recorded, outside the repo, so no config can move it (BOS-332). */
  private urlFile = (repo: string) => repo.replace(/\.git$/, ".url");

  private recordUrl(repo: string, url: string) {
    const file = this.urlFile(repo);
    if (url && (!existsSync(file) || readFileSync(file, "utf8") !== url)) writeFileSync(file, url);
  }

  /**
   * The recorded address. A repo cloned before BOS-332 has none until its next ensure; until then the
   * config's remote.origin.url is used if it is a single value (the guard has already removed pushurl and
   * url.*.insteadOf, which aren't on its allowlist), and that is logged.
   */
  private async remoteUrl(repo: string): Promise<string> {
    const file = this.urlFile(repo);
    if (existsSync(file)) return readFileSync(file, "utf8");
    const urls = (await this.git(["config", "--get-all", "remote.origin.url"], { cwd: repo }).catch(() => "")).split("\n").filter(Boolean);
    if (urls.length !== 1) throw new Error(`No recorded address for ${repo}, and its config doesn't name exactly one (BOS-332).`);
    console.warn(`[runner] ${repo} has no recorded address yet; using its config's remote.origin.url until the next ensure (BOS-332)`);
    return urls[0]!;
  }

  /**
   * Fetches origin's branches from the recorded address into refs/remotes/origin, as `git fetch origin` did.
   * Always time-limited (BOS-893), so a stalled network can't hang the step: every caller says how long it may take.
   */
  private async fetchOrigin(repo: string, auth: Record<string, string>, timeoutMs: number, tags = false) {
    await this.git(["fetch", "--quiet", await this.remoteUrl(repo), "+refs/heads/*:refs/remotes/origin/*", ...(tags ? ["+refs/tags/*:refs/tags/*"] : [])], { cwd: repo, env: auth, timeoutMs });
    // Every fetch keeps the agents' view current; a failure there never fails the caller (a merge, a check).
    await this.writeOriginView(repo).catch((err: unknown) => console.warn(`[runner] couldn't update ${repo}'s origin view (BOS-853): ${firstLine(err)}`));
  }

  /**
   * The origin view (BOS-853): a small bare repo inside the shared repo whose branches are origin's branches as the
   * shared repo last fetched them (its refs/remotes/origin/*) and whose tags are its tags. It borrows the shared repo's
   * objects. An agent's `git fetch` in a copy is sent here (copyGitConfig), so it works with no git login and gets
   * exactly what `git fetch origin` would, with the copy's usual refspec. It sits under the shared repo's root, which
   * fenced sessions can read but not write, so a push into it fails there too. The daemon writes its few files itself
   * and never runs git in it, so nothing an agent could plant in it is ever run by the runner.
   */
  originViewDir = (repo: string) => path.join(repo, "bossman-origin");

  private async writeOriginView(repo: string) {
    const view = this.originViewDir(repo);
    const listing = await this.git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin/", "refs/tags/"], { cwd: repo });
    const lines: string[] = [];
    const heads = new Set<string>();
    for (const line of listing.split("\n").filter(Boolean)) {
      const [sha, ref] = line.split(" ") as [string, string];
      if (ref === "refs/remotes/origin/HEAD") continue;
      if (ref.startsWith("refs/remotes/origin/")) {
        const name = ref.slice("refs/remotes/origin/".length);
        heads.add(name);
        lines.push(`${sha} refs/heads/${name}`);
      } else lines.push(`${sha} ${ref}`);
    }
    const format = await this.git(["rev-parse", "--show-object-format"], { cwd: repo }).catch(() => "sha1");
    const head = heads.has("main") ? "main" : heads.has("master") ? "master" : ([...heads].sort()[0] ?? "main");
    // Built aside and swapped in, so a fetch reading it never sees a half-made one. Whatever was in the old folder
    // (an unfenced agent's push, a planted hook) is dropped, not merged with.
    const tmp = `${view}.new`;
    const old = `${view}.old`;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
    mkdirSync(path.join(tmp, "objects", "info"), { recursive: true });
    mkdirSync(path.join(tmp, "refs", "heads"), { recursive: true });
    mkdirSync(path.join(tmp, "refs", "tags"), { recursive: true });
    writeFileSync(path.join(tmp, "objects", "info", "alternates"), `${path.join(repo, "objects")}\n`);
    writeFileSync(
      path.join(tmp, "config"),
      format === "sha1" ? "[core]\n\trepositoryformatversion = 0\n\tbare = true\n" : `[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = ${format}\n`,
    );
    writeFileSync(path.join(tmp, "HEAD"), `ref: refs/heads/${head}\n`);
    // No traits in the header: git sorts and peels the refs itself as it reads them.
    writeFileSync(path.join(tmp, "packed-refs"), `# pack-refs with: \n${lines.map((l) => `${l}\n`).join("")}`);
    if (lstatSync(view, { throwIfNoEntry: false })) renameSync(view, old);
    renameSync(tmp, view);
    rmSync(old, { recursive: true, force: true });
  }

  /**
   * Git config for a session working in one of the project's copies (BOS-853), as GIT_CONFIG_* pairs: the upstream
   * address is read from the origin view instead, so `git fetch` needs no login, and a push to it goes nowhere. Only
   * the session's own git reads these, never the runner's, and the copy's and shared repo's config files are untouched,
   * so this covers clones, worktrees, review copies and copies made before the change alike. Nothing when the
   * project has no recorded address yet, or the address carries a credential (which must never reach a session).
   */
  copyGitConfig(projectId: string): Array<[string, string]> {
    const repo = this.repoDir(projectId);
    const file = this.urlFile(repo);
    if (!existsSync(file) || !existsSync(path.join(this.originViewDir(repo), "HEAD"))) return [];
    const url = readFileSync(file, "utf8").trim();
    if (!url || hasCredential(url)) return [];
    return [
      [`url.${this.originViewDir(repo)}.insteadOf`, url],
      [`url.${NO_PUSH_URL}.pushInsteadOf`, url],
    ];
  }

  /**
   * At the start of a run in an existing copy (BOS-853): the shared repo is fetched from upstream (best effort: a
   * failure is logged once and the copy keeps what it has), then a clone gets origin's branches and the tags from it.
   * A worktree shares the shared repo's refs, so it is current already. The copy's own branch, HEAD, files and
   * shared/* refs are never touched. Callers hold the repo lock, so the upstream fetch is cut off at
   * runStartFetchTimeoutMs: a hung one would otherwise hold up every run start and merge in the project.
   */
  private async refreshCopy(projectId: string, repo: string, dir: string, auth: Record<string, string>) {
    try {
      await this.fetchOrigin(repo, auth, this.runStartFetchTimeoutMs, true);
    } catch (err) {
      console.warn(`[runner] couldn't refresh project ${projectId} from upstream at run start; the copy keeps the origin/main it has (BOS-853): ${firstLine(err)}`);
      // The view may not exist yet (a copy made before BOS-853): it's made from what the shared repo has.
      await this.writeOriginView(repo).catch(() => undefined);
    }
    if (!isClone(dir)) return;
    const r = await this.git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", repo, "+refs/remotes/origin/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"], { cwd: dir, repo }).then(
      () => null,
      (err: unknown) => err,
    );
    if (r) console.warn(`[runner] couldn't bring origin's branches into ticket copy ${dir} at run start (BOS-853): ${firstLine(r)}`);
  }

  /**
   * Pushes to the recorded address. A push by URL doesn't move refs/remotes/origin/<branch> as a push to
   * `origin` did, so a pushed ref is recorded there by hand, as before.
   */
  private async pushOrigin(repo: string, commit: string, branch: string, auth: Record<string, string>) {
    const pushed = await this.gitCode(["push", "--quiet", await this.remoteUrl(repo), `${commit}:refs/heads/${branch}`], { cwd: repo, env: auth });
    if (pushed.code === 0) await this.git(["update-ref", `refs/remotes/origin/${branch}`, commit], { cwd: repo });
    return pushed;
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
          else if (i > 600) throw new RepoLockTimeout(projectId);
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
    // The recorded address, not the config's (BOS-332): an agent may have pointed origin elsewhere.
    const url = await this.remoteUrl(repo);
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
      if (!ownAdminDir(repo, dir, admin)) throw new Error(`${dir} isn't a worktree of ${repo}.`);
      const head = await this.git(["rev-parse", "HEAD"], { cwd: dir, repo });
      const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: dir, repo }).catch(() => null);
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
    // The aside file is agent-writable: only an admin folder that points back at this very folder is ours to delete.
    const own = ownAdminDir(repo, dir, admin);
    if (own) rmSync(own, { recursive: true, force: true });
    rmSync(aside);
  }

  /**
   * A new copy for a ticket: a clone or a worktree, as configured. A half-made folder (no .git) in
   * the way is cleared first (BOS-634), unless it holds a clone conversion cut short (its old .git
   * set aside), which ensure finishes or undoes and nothing here may delete.
   */
  private async addCopy(repo: string, dir: string, commit: string, branch: string | null, newBranch = false) {
    if (existsSync(dir) && !existsSync(path.join(dir, ".git")) && !existsSync(path.join(dir, ".git.bossman-converting"))) rmSync(dir, { recursive: true, force: true });
    if (this.newCopiesAreClones()) return this.makeClone(repo, dir, commit, branch);
    if (!branch) return void (await this.git(["worktree", "add", "--quiet", "--detach", dir, commit], { cwd: repo }));
    if (!newBranch) return this.addBranchWorktree(repo, dir, branch);
    await this.git(["worktree", "add", "--quiet", "-b", branch, dir, commit], { cwd: repo });
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
    // The upload-pack reads the clone's config without going through git(), so it's checked here (BOS-332).
    if (lstatSync(path.join(dir, ".git"), { throwIfNoEntry: false })?.isDirectory()) await this.configGuard.check(path.join(dir, ".git", "config"));
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

  /**
   * Check out an existing ticket branch into the ticket's own folder as a worktree, recovering by
   * itself from the branch still being checked out in some other worktree of ours (BOS-634: an
   * agent switched branches inside another ticket's folder). The other worktree is moved to a
   * detached HEAD at the same commit: its files and uncommitted changes stay, only the branch is
   * released. A worktree outside our workspace root is never touched; that case fails with a clear
   * message. addCopy has already cleared a half-made folder in the way.
   */
  private async addBranchWorktree(repo: string, dir: string, branch: string): Promise<void> {
    await this.git(["worktree", "prune"], { cwd: repo });
    const listing = await this.git(["worktree", "list", "--porcelain"], { cwd: repo });
    const mine = path.resolve(dir);
    const tickets = path.resolve(this.root, "tickets") + path.sep;
    let current = "";
    for (const line of listing.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
      else if (line === `branch refs/heads/${branch}` && path.resolve(current) !== mine) {
        if (!path.resolve(current).startsWith(tickets)) {
          throw new Error(`Branch ${branch} is checked out in ${current}, outside this runner's workspaces; release it there first.`);
        }
        await this.git(["switch", "--detach", "--quiet"], { cwd: current, repo });
      }
    }
    await this.git(["worktree", "add", "--quiet", dir, branch], { cwd: repo });
  }

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
        await this.refreshCopy(spec.projectId, repo, dir, auth);
        const baseCommit = await this.git(["config", "--get", baseKey], { cwd: repo }).catch(() => "");
        return { path: dir, branch, baseCommit, created: false, restoredPatch: false };
      }

      await this.fetchOrigin(repo, auth, this.fetchTimeoutMs);
      await this.git(["worktree", "prune"], { cwd: repo });
      // Branch reflogs are how the real start point of a branch moved onto another ticket's work is found later (BOS-687).
      await this.git(["config", "core.logAllRefUpdates", "true"], { cwd: repo });
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
    if (existsSync(path.join(repo, "HEAD"))) return this.recordUrl(repo, spec.repoUrl);
    mkdirSync(path.dirname(repo), { recursive: true });
    await this.git(["clone", "--bare", "--quiet", spec.repoUrl, repo], { env: auth });
    // Remote branches go under refs/remotes, so fetching never touches the bossman/* branches.
    await this.git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], { cwd: repo });
    this.recordUrl(repo, spec.repoUrl);
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
        await this.fetchOrigin(repo, auth, this.fetchTimeoutMs);
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
      // A reviewer compares against origin/main too (BOS-853).
      await this.refreshCopy(spec.projectId, repo, dir, auth);
      return { path: dir, commit };
    });
  }

  /** One install at a time per review copy: a ticket's code and security reviewers share the folder. */
  private readonly reviewInstalls = new Map<string, Promise<unknown>>();

  /**
   * Installs a review copy's packages (BOS-693), so its reviewer can run the ticket's tests in place instead of building a
   * /tmp clone. Only for a pnpm project, and only from the shared store (BOS-568): with no shared store it does nothing
   * rather than start a store of its own. The install follows the branch's lockfile and runs its packages' scripts, which
   * nobody has reviewed yet, so it runs as a server-queued check job does: fenced where the runner can fence, with a HOME
   * of its own under check-jobs-home that goes afterwards (and that the start-up sweep takes if the runner dies mid-install).
   * Never throws: the review starts either way, and what happened is in `detail`.
   */
  async installReviewDeps(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, timeoutMs = REVIEW_INSTALL_TIMEOUT_MS): Promise<{ installed: boolean; detail: string }> {
    const dir = this.reviewDir(spec.ticketId);
    const prev = this.reviewInstalls.get(spec.ticketId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async (): Promise<{ installed: boolean; detail: string }> => {
      if (!existsSync(path.join(dir, "pnpm-lock.yaml"))) return { installed: false, detail: "not a pnpm project" };
      if (!this.jobFence?.pnpmStore) return { installed: false, detail: "this runner has no shared pnpm store" };
      const pnpm = (this.baseEnv.PATH ?? "").split(":").map((d) => d && path.join(d, "pnpm")).find((p) => p && existsSync(p));
      if (!pnpm) return { installed: false, detail: "pnpm isn't on this runner's PATH" };
      const id = randomUUID();
      const home = path.join(this.root, "check-jobs-home", id);
      this.activeJobs.add(id);
      try {
        const fence = this.jobFenceFor(this.repoDir(spec.projectId), dir, home);
        // CI: no prompts (and pnpm purges a node_modules made from another store without asking).
        const args = ["install", "--frozen-lockfile", "--prefer-offline", "--config.confirmModulesPurge=false"];
        const launch = fence.wrap ? fence.wrap(pnpm, args) : { bin: pnpm, args };
        const env = { PATH: this.baseEnv.PATH, CI: "1", ...fence.env } as NodeJS.ProcessEnv;
        const r = await runGroup(launch.bin, launch.args, dir, env, timeoutMs);
        if (r.code === 0) return { installed: true, detail: "installed" };
        return { installed: false, detail: `${r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit ${r.code}`}: ${r.output.slice(-500)}` };
      } catch (err) {
        return { installed: false, detail: String((err as Error)?.message ?? err).slice(0, 500) };
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(this.jobTmpDir(id), { recursive: true, force: true });
        this.activeJobs.delete(id);
      }
    });
    this.reviewInstalls.set(spec.ticketId, next);
    try {
      return await next;
    } finally {
      if (this.reviewInstalls.get(spec.ticketId) === next) this.reviewInstalls.delete(spec.ticketId);
    }
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

  /** Paths in `git status --porcelain -z` output (git() trims, so the first entry may have lost its leading space). */
  private static statusPaths(out: string): string[] {
    return out
      .split("\0")
      .filter(Boolean)
      .map((e) => (e[2] === " " ? e.slice(3) : e.slice(2)));
  }

  /**
   * What in the ticket's copy isn't on its branch, or null when nothing is (BOS-1231). Callers hold the repo lock.
   *
   * A copy can fall behind its own branch. An agent that checks the branch out in another ticket's folder and commits
   * there moves the branch, while this folder's index and files stay at the old commit (BOS-1128 and BOS-1130, 11 Nov).
   * `git status` here then shows everything since as uncommitted: the target's newer files, and the agent's own commits
   * undone. The merge told the author to commit all of it, which is other tickets' code.
   *
   * The sign is the copy's index: it is still exactly an older commit on the branch's first-parent line (a commit
   * made in this folder would have moved it along). Then the folder is moved from that commit to the branch head
   * with git's own two-tree switch (`read-tree -m -u`, what `git checkout` does): files the author changed and the
   * branch didn't are kept, and it refuses rather than overwrite one that clashes. Whatever is still uncommitted after
   * that is the author's own. If the switch refuses, the files that differ only because the branch moved on are
   * `foreign`: never offered to the author, who would be committing other tickets' code.
   *
   * The ticket's own commits made elsewhere count as moved-on too: their content is on the branch already.
   */
  private async uncommitted(repo: string, dir: string): Promise<Uncommitted | null> {
    const status = async () => Workspaces.statusPaths(await this.git(["status", "--porcelain", "-z", "--no-renames"], { cwd: dir, repo }));
    const files = await status();
    if (!files.length) return null;
    const behind = await this.staleAt(repo, dir);
    if (!behind) return { status: "uncommitted", files };
    const moved = await this.gitCode(["read-tree", "-m", "-u", behind, "HEAD"], { cwd: dir, repo });
    if (moved.code === 0) {
      console.warn(`[runner] ticket copy ${dir} was behind its own branch (at ${behind.slice(0, 8)}); moved it to the branch head (BOS-1231)`);
      const left = await status();
      return left.length ? { status: "uncommitted", files: left } : null;
    }
    const movedOn = new Set((await this.git(["diff", "--name-only", "--no-renames", "-z", behind, "HEAD"], { cwd: dir, repo })).split("\0").filter(Boolean));
    const foreign = files.filter((f) => movedOn.has(f));
    return { status: "uncommitted", files: files.filter((f) => !movedOn.has(f)), foreign };
  }

  /** The older commit on the branch's first-parent line whose tree the copy's index still is, or null (BOS-1231). */
  private async staleAt(repo: string, dir: string): Promise<string | null> {
    // write-tree only adds tree objects; it fails with unmerged entries, which is never a stale copy.
    const index = await this.gitCode(["write-tree"], { cwd: dir, repo });
    if (index.code !== 0 || !index.stdout) return null;
    const line = await this.git(["log", "--first-parent", "--max-count=2000", "--format=%H %T", "HEAD"], { cwd: dir, repo });
    const [head, ...older] = line.split("\n").map((l) => l.split(" "));
    if (!head || head[1] === index.stdout) return null;
    return older.find(([, t]) => t === index.stdout)?.[0] ?? null;
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
      const diff = await this.git(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"], { cwd: dir, repo });
      let savedPatch = false;
      if (diff) {
        mkdirSync(path.dirname(this.patchFile(spec.ticketId)), { recursive: true });
        writeFileSync(this.patchFile(spec.ticketId), `${diff}\n`);
        savedPatch = true;
      }
      if (clone) rmSync(dir, { recursive: true, force: true });
      else await this.git(["worktree", "remove", "--force", dir], { cwd: repo });
      await this.git(["worktree", "prune"], { cwd: repo });
      // The ticket is done with its worktree: its kept scratch goes with it (BOS-592), like the worktree's own files.
      // The server confirms that by itself (a ticket done, or a week past), so a stray release can't remove it first.
      const scratch = this.scratchDir(spec.ticketId);
      const age = Date.now() - (statSync(scratch, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > RELEASED_SCRATCH_KEEP_MS) rmSync(scratch, { recursive: true, force: true });
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
      // Raw blob bytes: --no-textconv, so a diff driver named in the config can't run; the config is checked first too.
      await this.configGuard.check(path.join(repo, "config"));
      const { stdout } = await run("git", ["show", "--no-textconv", `${branchFor(spec.ticketId)}:${rel}`], { cwd: repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, GIT_DIR: repo, ...SAFE_GIT_ENV } as NodeJS.ProcessEnv }).catch(() => {
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
    // The kept scratch (BOSSMAN_SCRATCH) counts too: a screenshot a proof left there is still the ticket's own image.
    const dirs = [this.ticketDir(ticketId), this.reviewDir(ticketId), path.join(this.root, ticketId), this.scratchDir(ticketId)].filter((d) => existsSync(d)).map((d) => realpathSync(d));
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

  /**
   * The base a review should be measured from (BOS-694): the merge-base of the ticket's head and a
   * freshly fetched origin/<baseRef>, the same split `git diff origin/<baseRef>...HEAD` uses, so a
   * branch that has merged main since it started shows only its own changes. Without a baseRef, or
   * when origin can't be reached, the recorded base stands: a stale diff's better than none.
   */
  private async reviewBase(repo: string, dir: string, head: string, recorded: string, baseRef: string | undefined, secrets: Record<string, string | undefined>): Promise<{ base: string; tip?: string }> {
    if (!baseRef) return { base: recorded };
    try {
      await this.fetchOrigin(repo, gitAuthEnv(secrets), this.fetchTimeoutMs);
      const tip = await this.git(["rev-parse", "--verify", `refs/remotes/origin/${baseRef}^{commit}`], { cwd: repo });
      // Where the branch split from main's current tip, however far main has moved since. Run in the
      // ticket's folder: a clone's own commits live in the clone, not the shared repo, which has only
      // tip (the clone sees it through its alternates).
      return { base: (await this.git(["merge-base", head, tip], { cwd: dir, repo })) || recorded, tip };
    } catch {
      return { base: recorded };
    }
  }

  async diff(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, maxBytes = 512 * 1024, baseRef?: string, secrets: Record<string, string | undefined> = {}): Promise<WorkspaceDiff> {
    const repo = this.repoDir(spec.projectId);
    const dir = await this.reopen(spec);
    const recorded = await this.git(["config", "--get", `bossman.ticket-${spec.ticketId}.base`], { cwd: repo });
    const head = await this.git(["rev-parse", "HEAD"], { cwd: dir, repo });
    // Fetches under the repo lock, like every other git call that touches the shared refs.
    const { base: baseCommit, tip } = await this.withRepoLock(spec.projectId, () => this.reviewBase(repo, dir, head, recorded, baseRef, secrets));
    // The tree is read from the same commit as head, before the slow steps: a commit landing
    // mid-diff must not leave head A tagged with B's tree (the check queue reuses passes by tree).
    const tree = await this.git(["rev-parse", `${head}^{tree}`], { cwd: dir, repo });
    // A fresh base can be far ahead of the recorded one; main's own commits aren't the ticket's work, so with a fetched
    // tip they are left out of its commit list.
    const log = await this.git(["log", "--format=%H%x09%s", `${baseCommit}..${head}`, ...(tip ? ["--not", tip] : [])], { cwd: dir, repo });
    const commits = log ? log.split("\n").map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })) : [];
    const scratch = this.scratch(`${spec.ticketId}.diff`);
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    try {
      await this.git(["read-tree", head], { cwd: dir, env, repo });
      await this.git(["add", "-A"], { cwd: dir, env, repo });
      // No external diff program or textconv driver: the diff is git's own (BOS-332).
      const numstat = await this.git(["diff", "--cached", "--numstat", "--no-ext-diff", "--no-textconv", baseCommit], { cwd: dir, env, repo });
      const files = numstat
        ? numstat.split("\n").map((l) => {
            const [a, r, ...p] = l.split("\t");
            return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r) };
          })
        : [];
      const full = await this.git(["diff", "--cached", "--no-ext-diff", "--no-textconv", baseCommit], { cwd: dir, env, repo });
      const truncated = Buffer.byteLength(full) > maxBytes;
      return { baseCommit, head, tree, commits, files, diff: truncated ? full.slice(0, maxBytes) : full, truncated };
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
      const files = await this.git(["diff", "--name-only", "--no-ext-diff", "--no-textconv", parent, commit], { cwd: dir, repo });
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
    const numstat = await this.git(["diff", "--numstat", "--no-ext-diff", "--no-textconv", from.commit, to.commit], { cwd });
    const files = numstat
      ? numstat.split("\n").map((l) => {
          const [a, r, ...p] = l.split("\t");
          return { path: p.join("\t"), added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r) };
        })
      : [];
    const full = await this.git(["diff", "--no-ext-diff", "--no-textconv", from.commit, to.commit], { cwd });
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
      // Fetch from the recorded address (BOS-332), never `origin` from config, which an agent can repoint to take the token.
      // A failed fetch isn't fatal: the check then reads the refs it already has, as before.
      await this.fetchOrigin(repo, auth, this.fetchTimeoutMs).catch(() => undefined);
      return checkMigrations((args) => this.gitCode(args, { cwd: repo }), repo, { branch: branchFor(spec.ticketId), target, others });
    });
  }

  /**
   * Runs the ticket's check (e.g. "pnpm test") in its worktree (R47). Output is kept to the
   * last 8 KB. It runs without the company's secrets: a check shouldn't need them.
   */
  async verify(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, command: string, timeoutMs = VERIFY_TIMEOUT_MS, queueMaxMs = VERIFY_QUEUE_MAX_MS, fence = false, scanList?: string): Promise<VerifyResult> {
    return this.runCheck(await this.reopen(spec), command, timeoutMs, queueMaxMs, undefined, fence ? spec.projectId : null, { projectId: spec.projectId, list: scanList });
  }

  /**
   * The check line's secrets and private-details scan (BOS-979), run by the runner's OWN installed copy of the scanner
   * (BOSSMAN_SCAN_SCRIPT, set by the runner image; root-owned like check-slot.sh) before any of the branch's code runs.
   * The branch's scripts can't remove or weaken it, and the owner's list (scanList) goes into a 0600 file outside the
   * copy that only this scanner reads, then is deleted: it is never in the check command's environment or its tree.
   * A runner without the scanner installed skips it (nothing to run). Returns the scanner's output when it blocks the change.
   */
  private async scanBeforeCheck(dir: string, projectId: string, scanList?: string): Promise<string | null> {
    const script = this.baseEnv.BOSSMAN_SCAN_SCRIPT;
    if (!script || !path.isAbsolute(script) || !existsSync(script)) return null;
    // The base is read from the shared repo's own refs (the branch can't move them), as a commit id.
    let base = "";
    for (const ref of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"]) {
      base = await this.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: this.repoDir(projectId) }).catch(() => "");
      if (base) break;
    }
    if (!base) return "scan: couldn't find the base branch (origin/main) to compare with, so the change was not scanned";
    const scratch = mkdtempSync(path.join(tmpdir(), "bm-scan-"));
    try {
      const env: NodeJS.ProcessEnv = { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME };
      if (scanList) {
        const file = path.join(scratch, "list");
        writeFileSync(file, scanList.endsWith("\n") ? scanList : `${scanList}\n`, { mode: 0o600 });
        env.BOSSMAN_SCAN_DENYLIST_FILE = file;
      }
      const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
        execFile(process.execPath, [script, base], { cwd: dir, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
          resolve({ code, out: `${stdout}${stderr}`.trim() });
        });
      });
      if (r.code === 0) return null;
      return r.out || "scan: the secrets and private-details scan failed to run, so the change was not scanned";
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private async runCheck(
    dir: string,
    command: string,
    timeoutMs: number,
    queueMaxMs = VERIFY_QUEUE_MAX_MS,
    job?: { onOutput?: (tail: string) => void; onStart?: (kill: () => void) => void; fence?: { env: Record<string, string>; wrap?: (bin: string, args: string[]) => { bin: string; args: string[] } } },
    fenceProject: string | null = null,
    scan?: { projectId: string; list?: string },
  ): Promise<VerifyResult> {
    if (scan) {
      const started = Date.now();
      const blocked = await this.scanBeforeCheck(dir, scan.projectId, scan.list);
      if (blocked) return { ok: false, exitCode: 1, timedOut: false, output: `${blocked}\ncheck stopped: the secrets and private-details scan found something, so the branch's own checks did not run.`, ms: Date.now() - started };
    }
    return this.spawnCheck(dir, command, timeoutMs, queueMaxMs, job, fenceProject);
  }

  /**
   * Runs a server-queued check job (DR-003, BOS-316): a detached worktree of exactly this commit, a process group the runner
   * owns, no lock files (the server holds the slots). Nothing here depends on an agent session. `cancel` is for the server only.
   */
  async runCommitCheck(
    spec: { projectId: string; jobId: string; commit: string },
    command: string,
    timeoutMs: number,
    hooks: { onOutput?: (tail: string) => void; onStart?: (cancel: () => void) => void; scanList?: string } = {},
  ): Promise<VerifyResult> {
    if (!/^[0-9a-f-]{36}$/i.test(spec.jobId)) throw new Error("the job id isn't a UUID");
    const repo = this.repoDir(spec.projectId);
    const dir = path.join(this.root, "check-jobs", spec.jobId);
    const home = path.join(this.root, "check-jobs-home", spec.jobId);
    this.activeJobs.add(spec.jobId);
    try {
      rmSync(dir, { recursive: true, force: true });
      await this.withRepoLock(spec.projectId, async () => {
        await this.git(["worktree", "prune"], { cwd: repo });
        mkdirSync(path.dirname(dir), { recursive: true });
        await this.git(["worktree", "add", "--quiet", "--detach", dir, spec.commit], { cwd: repo });
      });
      try {
        return await this.runCheck(dir, command, timeoutMs, VERIFY_QUEUE_MAX_MS, { onOutput: hooks.onOutput, onStart: hooks.onStart, fence: this.jobFenceFor(repo, dir, home) }, null, { projectId: spec.projectId, list: hooks.scanList });
      } finally {
        await this.withRepoLock(spec.projectId, async () => {
          await this.git(["worktree", "remove", "--force", dir], { cwd: repo }).catch(() => undefined);
          rmSync(dir, { recursive: true, force: true });
          await this.git(["worktree", "prune"], { cwd: repo }).catch(() => undefined);
        });
      }
    } finally {
      // The job's HOME/TMPDIR (whatever the tests left in it, and per-HOME caches) goes with the job.
      rmSync(home, { recursive: true, force: true });
      rmSync(this.jobTmpDir(spec.jobId), { recursive: true, force: true });
      this.activeJobs.delete(spec.jobId);
    }
  }

  /** Job ids whose folders belong to a check running in this process: the start-up sweep leaves them alone. */
  private readonly activeJobs = new Set<string>();

  /**
   * A job's TMPDIR (BOS-1087): short, so a Unix socket made under it (headless Chromium's, a test's) fits in 107 bytes.
   * It sits beside check-jobs-home, not inside the job's home, and goes with the job; the start-up sweep takes leftovers.
   */
  private jobTmpDir = (jobId: string) => path.join(this.root, "jt", shortTmpName(jobId));

  /**
   * The environment, and fence where the runner can fence, for one job, like an agent session's: the job's folder, its own home
   * and temp folder, the pnpm store, and the shared repo with only objects/refs/logs writable. The runner's token, data folder and
   * other tickets' worktrees are outside the fence. On a runner that can't fence, the job still gets its own HOME/TMPDIR and the
   * pnpm store on the workspaces volume (BOS-655), so its install doesn't fill the root disk under the runner's HOME; only the
   * file fence is missing (the same fallback sessions have).
   */
  /** NODE_PATH and PLAYWRIGHT_BROWSERS_PATH from the runner's own env, for a check that runs the real-browser web tests. */
  private browserToolEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.baseEnv.NODE_PATH) out.NODE_PATH = this.baseEnv.NODE_PATH;
    if (this.baseEnv.PLAYWRIGHT_BROWSERS_PATH) out.PLAYWRIGHT_BROWSERS_PATH = this.baseEnv.PLAYWRIGHT_BROWSERS_PATH;
    return out;
  }

  /** The folders behind browserToolEnv that exist, to grant read-only inside a fence. */
  private browserToolDirs(): string[] {
    return [...(this.baseEnv.NODE_PATH ?? "").split(":"), this.baseEnv.PLAYWRIGHT_BROWSERS_PATH ?? ""].filter((d) => d && path.isAbsolute(d) && existsSync(d));
  }

  private jobFenceFor(repo: string, dir: string, home: string): { env: Record<string, string>; wrap?: (bin: string, args: string[]) => { bin: string; args: string[] } } {
    const tmp = this.jobTmpDir(path.basename(home));
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    // BOS-1095: the temp folder used to sit inside home, so making it made home too. Now it sits apart (BOS-1087), so make home itself.
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const env: Record<string, string> = { HOME: home, TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, XDG_CACHE_HOME: path.join(home, ".cache"), XDG_CONFIG_HOME: path.join(home, ".config"), BOSSMAN_CHECK_STORE: "off", GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false", GIT_CONFIG_KEY_2: "gc.auto", GIT_CONFIG_VALUE_2: "0" };
    const readWrite: string[] = [];
    if (this.jobFence?.pnpmStore) {
      mkdirSync(this.jobFence.pnpmStore, { recursive: true });
      env.npm_config_store_dir = this.jobFence.pnpmStore;
      readWrite.push(this.jobFence.pnpmStore);
    }
    // BOS-1095: the web tests find Playwright through NODE_PATH (a global npm tool) and its browsers through
    // PLAYWRIGHT_BROWSERS_PATH. The job used to get neither, so those tests skipped ("Cannot find module 'playwright'").
    Object.assign(env, this.browserToolEnv());
    if (!this.jobFence || this.jobFence.level === "unavailable") return { env };
    const pathDirs = (this.baseEnv.PATH ?? "").split(":").filter((d) => d && existsSync(d));
    const readOnly = [...pathDirs, ...this.browserToolDirs()];
    // BOS-1039: a PATH entry is often a folder of links (npm's bin/ holds opencode -> ../lib/node_modules/opencode-ai/bin/...).
    // Landlock checks the real file, so a grant on the link's folder alone leaves the binary unreadable and a check that runs
    // a fenced agent fails with "permission denied". Grant the real folder of each agent binary found on PATH, read-only.
    for (const name of ["opencode", "claude", "codex"]) {
      for (const d of pathDirs) {
        try {
          const real = realpathSync(path.join(d, name));
          if (statSync(real).isFile()) {
            readOnly.push(path.dirname(real));
            break;
          }
        } catch {
          // not in this folder
        }
      }
    }
    // BOS-805: the job waits in the shared check line, so it may write the queue folder and read the gate folder (slot count).
    if (this.coordDir) {
      const grant = checkQueueGrant(this.coordDir);
      readWrite.push(grant.readWrite);
      readOnly.push(grant.readOnly);
    }
    const rules = fenceProfile({ cwd: dir, home, tmp, repo: repoGrant(repo, dir), readOnly, readWrite });
    return { env, wrap: (bin, args) => fencedCommand(rules, bin, args) };
  }

  /**
   * One check command in a folder: its own process group, output kept to the last 8 KB. A server-queued job (BOS-316) brings
   * its own fence and takes no lock; a merge check asked to run fenced (BOS-323) gets one from fenceCheck.
   */
  private spawnCheck(
    dir: string,
    command: string,
    timeoutMs: number,
    queueMaxMs = VERIFY_QUEUE_MAX_MS,
    job?: { onOutput?: (tail: string) => void; onStart?: (kill: () => void) => void; fence?: { env: Record<string, string>; wrap?: (bin: string, args: string[]) => { bin: string; args: string[] } } },
    fenceProject: string | null = null,
  ): Promise<VerifyResult> {
    const fence = fenceProject !== null;
    const started = Date.now();
    let tmp: string | null = null;
    return new Promise<VerifyResult>((resolve) => {
      // BOSSMAN_MERGE_CHECK: scripts/check-all.sh lets the merge check take the shared lock ahead of agents' hand-run checks.
      // A server-queued job (DR-003) takes no lock at all: the server holds the slots (BOSSMAN_CHECK_NO_LOCK).
      // The shared pnpm store (BOS-568): without it pnpm starts a new one in HOME for every install, on the root disk.
      // A merge check gets this.pnpmStore (its own gate store); a fenced job gets job.fence.env (the shared store);
      // a job on a runner that can't fence falls back to the shared job store, never this.pnpmStore (the gate's), so it
      // doesn't start a store in HOME either (BOS-568 review).
      const storeEnv = job ? (job.fence ? job.fence.env : this.jobFence?.pnpmStore ? { npm_config_store_dir: this.jobFence.pnpmStore } : {}) : this.pnpmStore ? { npm_config_store_dir: this.pnpmStore } : {};
      // BOS-805: a job also takes a runner slot from the same coord dir (the server's slot orders jobs, the runner's slots are the
      // machine's real limit, shared with hand-run checks and the vitest guard). Only the lock, the slot count (proof) and the
      // runner's slot script are passed on: the job keeps its own result store ("off" in its fence env).
      const queueEnv = this.coordDir ? checkQueueEnv(this.coordDir, this.baseEnv.BOSSMAN_CHECK_SLOT) : null;
      const jobTakesSlot = !!job && !!queueEnv?.BOSSMAN_CHECK_SLOT && existsSync(path.join(dir, "scripts", "check-all.sh"));
      const jobQueueEnv = jobTakesSlot && queueEnv ? { CHECK_ALL_LOCK: queueEnv.CHECK_ALL_LOCK, CHECK_ALL_PAIR_PROOF: queueEnv.CHECK_ALL_PAIR_PROOF, BOSSMAN_CHECK_SLOT: queueEnv.BOSSMAN_CHECK_SLOT } : { BOSSMAN_CHECK_NO_LOCK: "1" };
      let env = { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, CI: "1", BOSSMAN_MERGE_CHECK: "1", ...this.browserToolEnv(), ...(job ? jobQueueEnv : queueEnv ?? {}), ...storeEnv } as NodeJS.ProcessEnv;
      // BOS-614: a tree that takes part in the check line (it has scripts/check-all.sh) waits for its slot through the runner's
      // own check-slot.sh, not through the branch's copy of the queue rules: a branch based on older main brought older rules,
      // and old and new waiters jammed with both slots free. Inside, the branch's script gets a private lock and goes straight on.
      // The slot is then held for the whole command (light steps too); that costs a minute, a jammed line cost hours.
      // A job does the same (BOS-805) unless it has no slot script or coord dir: then it runs with BOSSMAN_CHECK_NO_LOCK as before.
      const inner = (job ? jobTakesSlot : env.BOSSMAN_CHECK_SLOT && existsSync(path.join(dir, "scripts", "check-all.sh"))) ?'bash "$BOSSMAN_CHECK_SLOT" sh -c "$0"' : 'sh -c "$0"';
      // Own process group, so a timeout can take down pnpm, tsc, vitest and their workers, not just the shell.
      // The check starts with default HUP/INT/TERM handling: a server started with those ignored would pass that on, and a shell can't undo it
      // (so check-all's own signal trap and its tests never fire). env --default-signal needs GNU coreutils; without it the command runs as before.
      // Inside the fence this wrapper runs as the fenced command, so both paths get it.
      const sigScript = `if env --default-signal=HUP,INT,TERM true 2>/dev/null; then exec env --default-signal=HUP,INT,TERM ${inner}; fi; exec ${inner}`;
      let launch = job?.fence?.wrap ? job.fence.wrap("sh", ["-c", sigScript, command]) : { bin: "sh", args: ["-c", sigScript, command] };
      // A merge check asked to run fenced (BOS-323); a job already brings its own fence. fenceCheck swaps the gate's store for
      // the shared one: the fenced check may write its store, and the unfenced gate must never install from one it could write.
      if (fence && !job && this.checkFence) ({ env, launch, tmp } = this.fenceCheck(fenceProject, dir, env, launch));
      const fenced = fence ? { fenced: tmp !== null } : {};
      const noCore = withoutCoreDumps(launch);
      const child = spawn(noCore.bin, noCore.args, {
        cwd: dir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          // group already gone
        }
      };
      job?.onStart?.(() => {
        timedOut = true;
        killGroup("SIGTERM");
        hardKill = setTimeout(() => finish(null), VERIFY_KILL_GRACE_MS);
      });
      let tail = "";
      // While check-all.sh waits in its queue the clock is the (long) queue limit; it restarts at the full timeout once the checks really begin.
      // The queue limit is a no-progress limit (BOS-370): it restarts whenever the printed place changes.
      let queued = false;
      let slotTaken = false;
      let lastPlace = "";
      // BOS-1228: a queued job also keeps the start and the end of the whole log (middle cut once it is too big), for check_log.
      let logHead = "";
      let logRest = "";
      let logCut = 0;
      const keepLog = (chunk: string) => {
        const toHead = Math.max(0, FULL_LOG_HEAD - logHead.length);
        logHead += chunk.slice(0, toHead);
        logRest += chunk.slice(toHead);
        const room = FULL_LOG_MAX - FULL_LOG_HEAD - 200;
        if (logRest.length > room * 1.2) {
          logCut += logRest.length - room;
          logRest = logRest.slice(-room);
        }
      };
      const onData = (chunk: string) => {
        if (job) keepLog(chunk);
        tail = (tail + chunk).slice(-8192);
        job?.onOutput?.(tail);
        if (!slotTaken && tail.includes(CHECK_STARTED_MARKER)) {
          slotTaken = true;
          arm(timeoutMs);
        } else if (!slotTaken && tail.includes(CHECK_QUEUED_MARKER)) {
          const place = [...chunk.matchAll(/waiting for a free check slot \(place (\d+) of/g)].pop()?.[1] ?? "";
          if (!queued || (place && place !== lastPlace)) arm(queueMaxMs);
          queued = true;
          if (place) lastPlace = place;
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
        // Only a log that is going to be kept is cut and redacted (a pass is not stored); a stop by the server adds its own line after.
        const fullLog = job && !(exitCode === 0 && !timedOut) ? prepareFullLog(logHead + (logCut ? `\n[... ${logCut} characters cut from the middle of the log ...]\n` : "") + logRest).log : undefined;
        resolve({ ok: !timedOut && exitCode === 0, exitCode: timedOut ? null : exitCode, timedOut, output: tail, ms: Date.now() - started, ...fenced, ...(fullLog !== undefined ? { fullLog } : {}) });
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
   * read-write on the ticket's copy, a fresh home and temp folder for this check, the pnpm
   * store and check-all's queue; read-only on the system, the runner's install, the global npm tools,
   * the browsers, check-all's results and the shared repo (for a worktree, what a commit writes too).
   * Nothing of the daemon's: not its HOME, its token or other tickets' copies.
   */
  private fenceCheck(projectId: string, dir: string, env: NodeJS.ProcessEnv, launch: { bin: string; args: string[] }) {
    const { home, pnpmStore } = this.checkFence!;
    // tmpRoot is short on a real runner (BOS-1087): a socket under TMPDIR must fit in 107 bytes. "c" + 6 characters here.
    const tmpRoot = this.checkFence!.tmpRoot ?? path.join(home, "tmp");
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(path.join(tmpRoot, this.checkFence!.tmpRoot ? "c" : "check-"));
    // A fresh HOME per check, gone with the temp folder: one ticket's check scripts can't plant dotfiles
    // (.gitconfig, .npmrc) that a later ticket's check would run with write access to its copy (Jane's finding).
    const checkHome = path.join(tmp, "home");
    mkdirSync(checkHome);
    const out: NodeJS.ProcessEnv = { ...env, HOME: checkHome, TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp };
    const readWrite: string[] = [];
    const readOnly = [this.baseEnv.NPM_CONFIG_PREFIX, ...this.browserToolDirs()].filter((p): p is string => !!p);
    if (pnpmStore) {
      mkdirSync(pnpmStore, { recursive: true });
      // pnpm keeps the store's location in HOME's config; without this it starts a new store in the copy.
      out.npm_config_store_dir = pnpmStore;
      readWrite.push(pnpmStore);
    } else delete out.npm_config_store_dir; // never the gate's own store (BOS-568): the fence doesn't grant it
    if (this.baseEnv.NPM_CONFIG_PREFIX) out.NPM_CONFIG_PREFIX = this.baseEnv.NPM_CONFIG_PREFIX;
    if (this.baseEnv.PLAYWRIGHT_BROWSERS_PATH) out.PLAYWRIGHT_BROWSERS_PATH = this.baseEnv.PLAYWRIGHT_BROWSERS_PATH;
    if (this.coordDir) {
      const grant = checkQueueGrant(this.coordDir);
      readWrite.push(grant.readWrite);
      readOnly.push(grant.readOnly);
    }
    // A worktree's shared repo has a read-only root, where auto-gc would write.
    addGitConfig(out, "gc.auto", "0");
    const rules = fenceProfile({ cwd: dir, home: checkHome, tmp, repo: repoGrant(this.repoDir(projectId), dir), readOnly, readWrite });
    return { env: out, launch: fencedCommand(rules, launch.bin, launch.args), tmp };
  }

  /**
   * Merges the ticket's branch into a named target without any working tree (R46). The merge is
   * tried with merge-tree (exit codes, never output text); a clean result becomes a merge
   * commit pushed to the target. Nothing is cleaned or reset, so files outside the ticket's
   * worktree can't be touched. If the target moved meanwhile, the push is rejected and the
   * merge is tried once more.
   */
  async merge(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, message: string, secrets: Record<string, string | undefined> = {}, checks: { commands: string[]; timeoutMs?: number } | null = null, phase: MergePhase | null = null): Promise<MergeResult> {
    if (phase) return this.mergePhase(spec, target, message, secrets, phase);
    if (checks?.commands.length) return this.mergeChecked(spec, target, message, secrets, checks.commands, checks.timeoutMs ?? VERIFY_TIMEOUT_MS);
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      const dir = this.ticketDir(spec.ticketId);
      const branch = `refs/heads/${branchFor(spec.ticketId)}`;
      if (existsSync(path.join(dir, ".git"))) {
        const dirty = await this.uncommitted(repo, dir);
        if (dirty) return dirty;
        if (isClone(dir)) await this.syncBranch(repo, dir, spec.ticketId);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const tried = await this.tryMerge(repo, branch, target, auth);
        if (tried.status !== "clean") return tried;
        const { tree, targetSha, branchSha } = tried;
        // Drizzle silently skips a migration whose "when" isn't later than the newest applied one (BOS-360): read both journals, nothing is checked out.
        const gitIn = (args: string[]) => this.gitCode(args, { cwd: repo });
        const problems = journalProblems(await journalAt(gitIn, targetSha), await journalAt(gitIn, tree), Date.now(), target);
        if (problems.length) return { status: "migration_journal" as const, problems };
        const who = this.authorEnv();
        const commit = await this.git(["commit-tree", tree, "-p", targetSha, "-p", branchSha, "-m", message], { cwd: repo, env: who });
        const pushed = await this.pushOrigin(repo, commit, target, auth);
        if (pushed.code === 0) return { status: "merged", commit, ...(tried.renamed ? { renamed: tried.renamed } : {}) };
        if (attempt === 1) throw new Error(`Couldn't push the merge to ${target}: ${pushed.stderr.slice(0, 500)}`);
      }
      throw new Error("unreachable");
    });
  }

  /**
   * Server-queued merge checks (DR-003, BOS-316) split the merge in two. "prepare" builds the merge commit and keeps it under a
   * ref so the queued check can open exactly that commit; nothing is pushed. "finish" pushes the checked commit only if the merge
   * of the branch and the target's current tip still has the checked tree; otherwise main_moved, and the server prepares again.
   */
  private async mergePhase(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, message: string, secrets: Record<string, string | undefined>, phase: MergePhase): Promise<MergeResult> {
    const auth = gitAuthEnv(secrets);
    // Merge train (BOS-1366): prepare stacks on a given base; finish refuses unless main's tip is exactly the expected base.
    const base = phase.phase === "prepare" ? phase.base : phase.expectBase;
    const repo = this.repoDir(spec.projectId);
    const branch = `refs/heads/${branchFor(spec.ticketId)}`;
    const keep = `refs/bossman/merge/${spec.ticketId}`;
    return this.withRepoLock(spec.projectId, async (): Promise<MergeResult> => {
      const ticketDir = this.ticketDir(spec.ticketId);
      if (existsSync(path.join(ticketDir, ".git"))) {
        const dirty = await this.uncommitted(repo, ticketDir);
        if (dirty) return dirty;
        // Both phases sync, like mergeChecked: finish then sees a commit made since prepare as a changed tree (main_moved).
        if (isClone(ticketDir)) await this.syncBranch(repo, ticketDir, spec.ticketId);
      }
      // finish with expectBase: tryMerge's own fetch tells whether main is still at that base; anything else is main_moved
      // and nothing is pushed. With the tip equal to the base, the checked commit's parents match, so it is pushed itself.
      const tried = await this.tryMerge(repo, branch, target, auth, base ? { base, exact: phase.phase === "finish" } : undefined);
      if (tried.status !== "clean") return tried;
      const gitIn = (args: string[]) => this.gitCode(args, { cwd: repo });
      const problems = journalProblems(await journalAt(gitIn, tried.targetSha), await journalAt(gitIn, tried.tree), Date.now(), target);
      if (problems.length) return { status: "migration_journal" as const, problems };
      if (phase.phase === "prepare") {
        const commit = await this.git(["commit-tree", tried.tree, "-p", tried.targetSha, "-p", tried.branchSha, "-m", message], { cwd: repo, env: this.authorEnv() });
        await this.git(["update-ref", keep, commit], { cwd: repo });
        return { status: "prepared", commit, tree: tried.tree, targetSha: tried.targetSha, ...(tried.renamed ? { renamed: tried.renamed } : {}) };
      }
      // The target moved to something whose merge differs from what was checked: check again.
      if (tried.tree !== phase.tree) return { status: "main_moved" };
      // Same tree. The checked commit itself if its parents are still current; otherwise a new commit with the same tree.
      const parents = (await this.git(["rev-list", "--parents", "-n", "1", phase.commit], { cwd: repo })).split(" ").slice(1);
      const same = parents[0] === tried.targetSha && parents[1] === tried.branchSha;
      const toPush = same ? phase.commit : await this.git(["commit-tree", tried.tree, "-p", tried.targetSha, "-p", tried.branchSha, "-m", message], { cwd: repo, env: this.authorEnv() });
      const pushed = await this.pushOrigin(repo, toPush, target, auth);
      if (pushed.code !== 0) {
        // Rejected: the target moved again (try once more) or the push is refused for good (the next prepare would say so).
        const again = await this.git(["rev-parse", "--verify", `refs/remotes/origin/${target}^{commit}`], { cwd: repo });
        if (again === tried.targetSha) throw new Error(`Couldn't push the merge to ${target}: ${pushed.stderr.slice(0, 500)}`);
        return { status: "main_moved" };
      }
      await this.git(["update-ref", "-d", keep], { cwd: repo }).catch(() => undefined);
      return { status: "merged", commit: toPush, checked: { sha: phase.commit, tree: tried.tree, ms: 0 }, ...(tried.renamed ? { renamed: tried.renamed } : {}) };
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
          const dirty = await this.uncommitted(repo, ticketDir);
          if (dirty) return dirty;
          if (isClone(ticketDir)) await this.syncBranch(repo, ticketDir, spec.ticketId);
        }
        const tried = await this.tryMerge(repo, branch, target, auth);
        if (tried.status !== "clean") return tried;
        // Same journal rule as the plain merge (BOS-360): a refused branch builds and pushes nothing.
        const gitIn = (args: string[]) => this.gitCode(args, { cwd: repo });
        const problems = journalProblems(await journalAt(gitIn, tried.targetSha), await journalAt(gitIn, tried.tree), Date.now(), target);
        if (problems.length) return { status: "migration_journal" as const, problems };
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
        const pushed = await this.pushOrigin(repo, toPush, target, auth);
        if (pushed.code === 0) return { status: "merged", commit: toPush, checked: { sha: checked.commit, tree: tried.tree, ms: checkedMs }, ...(tried.renamed ? { renamed: tried.renamed } : {}) };
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

  /**
   * Fetches, then tries the ticket's branch on top of origin's target with merge-tree. `on` (merge train, BOS-1366): try it on
   * `on.base` instead, a commit that must be the target's tip or built on it (a train member ahead's prepared merge); with
   * `on.exact` the target's tip must be that very commit. Otherwise main_moved: the train restacks on the real main.
   */
  private async tryMerge(repo: string, branch: string, target: string, auth: Record<string, string>, on?: { base: string; exact: boolean }) {
    await this.fetchOrigin(repo, auth, this.fetchTimeoutMs);
    const tip = await this.git(["rev-parse", "--verify", `refs/remotes/origin/${target}^{commit}`], { cwd: repo });
    let targetSha = tip;
    if (on && on.base !== tip) {
      if (on.exact) return { status: "main_moved" as const };
      // The base must be here (a member ahead re-prepared and its old commit may be gone) and descend from main's tip.
      const known = await this.gitCode(["rev-parse", "--verify", "--quiet", `${on.base}^{commit}`], { cwd: repo });
      if (known.code !== 0) return { status: "main_moved" as const };
      const onMain = await this.gitCode(["merge-base", "--is-ancestor", tip, on.base], { cwd: repo });
      if (onMain.code !== 0) return { status: "main_moved" as const };
      targetSha = on.base;
    }
    const branchSha = await this.git(["rev-parse", "--verify", `${branch}^{commit}`], { cwd: repo });
    const ancestor = await this.gitCode(["merge-base", "--is-ancestor", branchSha, targetSha], { cwd: repo });
    if (ancestor.code === 0) return { status: "already_merged" as const, commit: targetSha };
    const tried = await this.gitCode(["merge-tree", "--write-tree", "--name-only", "--messages", targetSha, branchSha], { cwd: repo });
    // When the only trouble is migration bookkeeping, the gate renumbers the branch's migration itself (BOS-690, DR-037).
    // Anything it can't do safely comes back "refused" and the merge result is what it was before.
    const rebuild = async () => {
      const mb = await this.gitCode(["merge-base", targetSha, branchSha], { cwd: repo });
      if (mb.code !== 0 || !mb.stdout) return null;
      const r = await rebaseMigrations((args, env) => this.gitCode(args, { cwd: repo, env }), { base: mb.stdout, branch: branchSha, main: targetSha });
      return r.status === "rebuilt" ? r : null;
    };
    if (tried.code === 1) {
      const lines = tried.stdout.split("\n");
      const files = lines.slice(1, lines.indexOf("") === -1 ? undefined : lines.indexOf("")).filter(Boolean);
      const rebuilt = await rebuild();
      if (rebuilt) return { status: "clean" as const, tree: rebuilt.tree, targetSha, branchSha, renamed: rebuilt.renamed };
      return { status: "conflicts" as const, files };
    }
    if (tried.code !== 0) throw new Error(`git merge-tree failed (exit ${tried.code}): ${tried.stderr.slice(0, 500)}`);
    const tree = tried.stdout.split("\n")[0]!;
    // A clean merge can still leave the journal wrong (an old "when"); the rebuild lifts it.
    const gitIn = (args: string[]) => this.gitCode(args, { cwd: repo });
    if (journalProblems(await journalAt(gitIn, targetSha), await journalAt(gitIn, tree), Date.now(), target).length) {
      const rebuilt = await rebuild();
      if (rebuilt) return { status: "clean" as const, tree: rebuilt.tree, targetSha, branchSha, renamed: rebuilt.renamed };
    }
    return { status: "clean" as const, tree, targetSha, branchSha, renamed: undefined };
  }

  /**
   * Whether the ticket's branch still merges into the target (BOS-426): the same merge-tree try as a
   * merge, but nothing is built or pushed. A branch that is gone here, or a failed git call, throws:
   * the caller must not read "couldn't tell" as "clean".
   */
  async clash(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, secrets: Record<string, string | undefined> = {}): Promise<{ clashes: boolean; files: string[] }> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      if (!existsSync(path.join(repo, "HEAD"))) throw new Error("This runner has no copy of that project's repo.");
      // A clone's branch reaches the shared repo only when it's synced (BOS-343). Merge and push sync
      // first; so must this check, or it merges a stale branch (BOS-832: false clashes, and real ones missed).
      const dir = this.ticketDir(spec.ticketId);
      if (isClone(dir)) await this.syncBranch(repo, dir, spec.ticketId);
      const tried = await this.tryMerge(repo, `refs/heads/${branchFor(spec.ticketId)}`, target, auth);
      return tried.status === "conflicts" ? { clashes: true, files: tried.files } : { clashes: false, files: [] };
    });
  }

  /**
   * Whether the owner's sign-off on `signed` still covers the ticket's branch head (BOS-734, DR-038): only
   * clean automatic merges of the target came in since. Fails closed: any git doubt says "does not cover".
   */
  async signoffCovers(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, target: string, signed: string, secrets: Record<string, string | undefined> = {}, expectHead?: string): Promise<SignoffCover> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      if (!existsSync(path.join(repo, "HEAD"))) throw new Error("This runner has no copy of that project's repo.");
      await this.fetchOrigin(repo, auth, this.fetchTimeoutMs);
      const head = await this.git(["rev-parse", "--verify", `refs/heads/${branchFor(spec.ticketId)}^{commit}`], { cwd: repo });
      // The caller checked this head; if the branch ref says otherwise, the answer would be about different code (BOS-734).
      if (expectHead && !head.startsWith(expectHead) && !expectHead.startsWith(head)) {
        return { covers: false, reason: "the branch moved while this was being checked", newCommits: 0, handMerges: 0 };
      }
      return checkSignoffCovers((args) => this.gitCode(args, { cwd: repo }), signed, head, `refs/remotes/origin/${target}`);
    });
  }

  /**
   * Where a ticket's branch really started (BOS-687). The recorded base is where the runner created
   * the branch, normally a main commit. A branch the agent then moved onto another ticket's work
   * before committing anything of its own (`git reset --hard <sha>`, `git switch -C`) started
   * there: the branch's reflog shows the move ahead of its first commit. That point is used for this
   * check only, never written back: the recorded base also drives the review diff and the agent can
   * shape the reflog. It counts only when the ticket being checked holds that commit.
   * A merge or fast-forward is not a start: that shape stays reported (BOS-369). Without a reflog
   * (a branch older than reflogs here) the recorded base stands.
   */
  private async realBase(repo: string, b: { ticketId: string; branch: string }, holders: string[]): Promise<string> {
    const key = `bossman.ticket-${b.ticketId}.base`;
    const recorded = await this.git(["config", "--get", key], { cwd: repo }).catch(() => "");
    if (!recorded) return "";
    // A clone's branch moves in the clone (BOS-323); the shared repo's reflog for it only shows the syncs, so the move is
    // read where it happened, through the clone's fenced git. A released clone has no reflog left: the recorded base stands.
    const copy = this.ticketDir(b.ticketId);
    const log = await this.gitCode(["reflog", "show", "--format=%H %gs", `refs/heads/${b.branch}`], isClone(copy) ? { cwd: copy, repo } : { cwd: repo });
    if (log.code !== 0) return recorded;
    let start = "";
    // The reflog lists newest first; walk from the oldest entry up to the branch's first commit.
    for (const line of log.stdout.split("\n").filter(Boolean).reverse()) {
      const [sha, ...msg] = line.split(" ");
      const text = msg.join(" ");
      // A fast-forward merge before the branch's first commit moves it just as a reset does (BOS-733: BOS-726
      // was made from main, then `git merge` fast-forwarded it onto BOS-725's tip). It has no commit of its own
      // yet, so everything it moved onto came from elsewhere; the guards below still apply. git writes this
      // reflog text untranslated.
      if (/^merge [^:]+: Fast-forward$/.test(text) && sha) {
        start = sha;
        continue;
      }
      if (/^commit|^merge|^rebase|^cherry-pick/.test(text)) break;
      if (/^reset: moving to|^branch: Reset to|^checkout: moving/.test(text) && sha) start = sha;
    }
    if (!start || start === recorded) return recorded;
    // Only when the new start sits on top of the recorded base (it descends from it), and only when
    // the ticket being checked really holds it: then the commits it shields are ones that ticket has.
    // The reflog is the agent's to shape, so a start the checked ticket doesn't hold is ignored.
    const above = (await this.gitCode(["merge-base", "--is-ancestor", recorded, start], { cwd: repo })).code === 0;
    if (!above) return recorded;
    // A deeper stack (C on B on A, checking A) has C start at B's tip, which B holds: another open
    // ticket's branch counts too, never the branch being judged.
    for (const holder of holders) {
      if ((await this.gitCode(["merge-base", "--is-ancestor", start, `refs/heads/${holder}`], { cwd: repo })).code === 0) return start;
    }
    return recorded;
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
      await this.fetchOrigin(repo, auth, this.fetchTimeoutMs);
      // A failed rev-list mustn't look like "no commits": a safety gate that can't answer has to
      // say so, not report the branch clean (BOS-130).
      const refs = async (ref: string, firstParent = false) => {
        const r = await this.gitCode(["rev-list", ...(firstParent ? ["--first-parent"] : []), ref, "--not", `refs/remotes/origin/${target}`], { cwd: repo });
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
        // B is carried when this branch holds a commit on B's own first-parent line (B's work).
        // Commits B has only by merging this ticket in are on this ticket's side, not B's line (BOS-365).
        const bLine = await refs(b.branch, true);
        if (bLine.some((sha) => mine.has(sha))) {
          // Whether this branch holds all of B (B's tip is an ancestor of ours): then merging this one lands B too, which the
          // server may allow when B is approved (BOS-372). From the graph alone a fast-forward can't be told from a hole; B's
          // reflog can, when the fast-forward was B's first move (realBase, BOS-733).
          const contained = (await this.gitCode(["merge-base", "--is-ancestor", `refs/heads/${b.branch}`, `refs/heads/${branchFor(spec.ticketId)}`], { cwd: repo })).code === 0;
          // B stacked on this ticket (BOS-629): B was created from a commit this branch holds. The graph alone can't say who
          // wrote a shared commit, but the base the runner recorded when it created B's branch can: a shared commit that is
          // at or below that base was already there when B started, so it isn't B's work. Any shared commit above B's base
          // (B's own, or one B has only because this ticket took it) is still reported (BOS-369), and so is a branch with no
          // recorded base, since the gate has to fail safe.
          if (!contained) {
            const base = await this.realBase(repo, b, [branchFor(spec.ticketId), ...branches.map((o) => o.branch).filter((n) => n !== b.branch)]);
            if (base) {
              let allBelowBase = true;
              for (const sha of bLine.filter((s) => mine.has(s))) {
                if ((await this.gitCode(["merge-base", "--is-ancestor", sha, base], { cwd: repo })).code !== 0) {
                  allBelowBase = false;
                  break;
                }
              }
              if (allBelowBase) continue;
            }
          }
          found.push({ ticketId: b.ticketId, branch: b.branch, contained });
        }
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
        const dirty = await this.uncommitted(repo, dir);
        if (dirty) return dirty;
        if (isClone(dir)) await this.syncBranch(repo, dir, spec.ticketId);
      }
      const tried = await this.tryMerge(repo, `refs/heads/${name}`, target, auth);
      if (tried.status === "main_moved") throw new Error("unreachable: no base was given");
      if (tried.status !== "clean") return tried;
      const pushed = await this.pushOrigin(repo, tried.branchSha, name, auth);
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
      await this.cloneIfMissing(spec, auth);
      await this.fetchOrigin(repo, auth, this.fetchTimeoutMs);
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
   * What a deploy's ref is (DR-033): after a fetch, the commit it names (a remote branch first, then a tag or
   * sha), whether that commit is on origin's base branch, and the remote's branch names. Read-only. A ref
   * that isn't git-shaped, or names nothing, gives commit null rather than an error: deploys of image tags go on.
   */
  async resolve(spec: { projectId: string; repoUrl: string; ref: string; baseRef: string }, secrets: Record<string, string | undefined> = {}): Promise<ResolveResult> {
    const auth = gitAuthEnv(secrets);
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      await this.cloneIfMissing(spec, auth);
      await this.git(["fetch", "--quiet", "--tags", "--force", "origin"], { cwd: repo, env: auth });
      const branches = await this.remoteBranches(repo);
      if (!DEPLOY_REF.test(spec.ref) || !DEPLOY_REF.test(spec.baseRef)) return { commit: null, onBase: false, branches, error: "That ref isn't a git branch, tag or commit." };
      const candidates = [`refs/remotes/origin/${spec.ref}`, `refs/tags/${spec.ref}`, spec.ref];
      let commit: string | null = null;
      for (const c of candidates) {
        const r = await this.gitCode(["rev-parse", "--verify", "--quiet", "--end-of-options", `${c}^{commit}`], { cwd: repo });
        if (r.code === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(r.stdout)) {
          commit = r.stdout;
          break;
        }
      }
      if (!commit) return { commit: null, onBase: false, branches, error: `${spec.ref} doesn't name a commit in the repository.` };
      return { commit, onBase: await this.onBase(repo, commit, spec.baseRef), branches };
    });
  }

  /** The remote's branch names, as fetched into refs/remotes/origin. */
  private async remoteBranches(repo: string): Promise<string[]> {
    const out = await this.git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"], { cwd: repo });
    return out
      .split("\n")
      .map((l) => l.replace(/^refs\/remotes\/origin\//, ""))
      .filter((b) => b && b !== "HEAD");
  }

  private async onBase(repo: string, commit: string, baseRef: string): Promise<boolean> {
    const r = await this.gitCode(["merge-base", "--is-ancestor", commit, `refs/remotes/origin/${baseRef}`], { cwd: repo });
    return r.code === 0;
  }

  /**
   * Moves a deploy target's tag on origin to the commit a deploy shipped (DR-033). The daemon trusts nothing it
   * is sent: under the repo lock it checks the name (check-ref-format, one component, not a branch on the
   * remote) and that the commit is on the base branch, reads the tag's current value from the remote, and pushes
   * `<commit>:refs/tags/<name>` with a lease on that value. The refspec is built here only; it always has a sha on
   * the left, so it can never delete, and always refs/tags/ on the right, so it can never move a branch.
   *
   * A lease failure means someone else moved the tag between the read and the push. The tag is read once more:
   * if it now points at this commit the result is "unchanged", otherwise "failed" and it stays where they put it.
   */
  async tag(spec: { projectId: string; repoUrl: string; name: string; commit: string; baseRef: string }, secrets: Record<string, string | undefined> = {}): Promise<TagResult> {
    const auth = gitAuthEnv(secrets);
    const refuse = (error: string): TagResult => ({ result: "refused", from: null, to: spec.commit, error });
    const nameProblem = deployTagNameProblem(spec.name);
    if (nameProblem) return refuse(nameProblem);
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(spec.commit)) return refuse("The commit isn't a full sha.");
    if (!DEPLOY_REF.test(spec.baseRef)) return refuse("The base branch name isn't valid.");
    const ref = `refs/tags/${spec.name}`;
    return this.withRepoLock(spec.projectId, async () => {
      const repo = this.repoDir(spec.projectId);
      await this.cloneIfMissing(spec, auth);
      const format = await this.gitCode(["check-ref-format", ref], { cwd: repo });
      if (format.code !== 0) return refuse(`git refuses ${spec.name} as a tag name.`);
      await this.git(["fetch", "--quiet", "origin"], { cwd: repo, env: auth });
      const heads = await this.gitCode(["ls-remote", "--heads", "origin"], { cwd: repo, env: auth });
      if (heads.code !== 0) return { result: "failed", from: null, to: spec.commit, error: `Couldn't list the remote's branches: ${heads.stderr.slice(0, 500)}` };
      const branchNames = heads.stdout.split("\n").map((l) => l.split("\t")[1]?.replace(/^refs\/heads\//, "")).filter(Boolean);
      if (branchNames.includes(spec.name)) return refuse(`${spec.name} is also a branch on the remote, so it can't be used as the deploy tag.`);
      if (!(await this.onBase(repo, spec.commit, spec.baseRef))) return refuse(`${spec.commit.slice(0, 7)} isn't on ${spec.baseRef}, so the tag stays where it is.`);
      const read = async (): Promise<string | null | Error> => {
        const r = await this.gitCode(["ls-remote", "origin", ref], { cwd: repo, env: auth });
        if (r.code !== 0) return new Error(r.stderr.slice(0, 500));
        const line = r.stdout.split("\n").find((l) => l.split("\t")[1] === ref);
        return line ? line.split("\t")[0]! : null;
      };
      const before = await read();
      if (before instanceof Error) return { result: "failed", from: null, to: spec.commit, error: `Couldn't read the tag from the remote: ${before.message}` };
      if (before === spec.commit) return { result: "unchanged", from: before, to: spec.commit };
      const pushed = await this.gitCode(["push", "--quiet", "--no-verify", `--force-with-lease=${ref}:${before ?? ""}`, "origin", `${spec.commit}:${ref}`], { cwd: repo, env: auth });
      if (pushed.code === 0) return { result: "moved", from: before, to: spec.commit };
      const after = await read();
      if (after === spec.commit) return { result: "unchanged", from: before, to: spec.commit };
      if (typeof after === "string" && after !== before) {
        return { result: "failed", from: before, to: spec.commit, error: `Someone else moved ${spec.name} to ${after.slice(0, 7)} while Boss Man was moving it, so it was left there.` };
      }
      return { result: "failed", from: before, to: spec.commit, error: pushed.stderr.slice(0, 1000) || `git push exited with code ${pushed.code}` };
    });
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

    // Scratch (BOSSMAN_SCRATCH, BOS-592) lives on the kept disk and is never the clutter the tmp sweep
    // clears, so it goes only when its ticket's work (and review copy) are released and it has been quiet for a few
    // hours, or after a week without a write, whichever comes first. A run inside the last week is barely writing:
    // touching a folder at its top level keeps it alive.
    const scratch: DiskReport["scratch"] = [];
    const scratchRoot = path.join(this.root, "scratch");
    for (const ticketId of list(scratchRoot)) {
      // Only a per-ticket folder is ever touched: nothing here can reach another folder of the volume.
      if (!UUID.test(ticketId)) continue;
      const dir = path.join(scratchRoot, ticketId);
      const released = !existsSync(this.ticketDir(ticketId)) && !existsSync(path.join(this.root, "reviews", ticketId));
      const age = now - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? now);
      if ((released && age > RELEASED_SCRATCH_KEEP_MS) || age > SCRATCH_KEEP_MS) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(ticketId);
        continue;
      }
      scratch.push({ ticketId, bytes: await diskUsage(dir) });
    }

    // A review copy git no longer knows about (its repo pruned it) is only clutter.
    for (const ticketId of list(path.join(this.root, "reviews"))) {
      const dir = path.join(this.root, "reviews", ticketId);
      if (!copyProject(dir) && now - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? now) > 10 * 60_000) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(ticketId);
      }
    }

    // Check-job folders no running job owns: a runner restart mid-job skips the job's own clean-up. Jobs that
    // start after this point are in activeJobs before they create anything, so the sweep never takes their folders.
    for (const sub of ["check-jobs", "check-jobs-home"]) {
      for (const jobId of list(path.join(this.root, sub))) {
        if (this.activeJobs.has(jobId)) continue;
        rmSync(path.join(this.root, sub, jobId), { recursive: true, force: true });
        removed.push(`${sub}/${jobId}`);
      }
    }
    // Their short temp folders (BOS-1087), spared while a running job owns them.
    const liveTmp = new Set([...this.activeJobs].map((id) => shortTmpName(id)));
    for (const name of list(path.join(this.root, "jt"))) {
      if (liveTmp.has(name)) continue;
      rmSync(path.join(this.root, "jt", name), { recursive: true, force: true });
      removed.push(`jt/${name}`);
    }
    // Their worktree entries in the repos are stale now.
    for (const name of list(reposDir).filter((n) => n.endsWith(".git"))) {
      await this.withRepoLock(name.slice(0, -4), () => this.git(["worktree", "prune"], { cwd: this.repoDir(name.slice(0, -4)) })).catch(() => undefined);
    }

    const tmp = path.join(this.root, "tmp");
    for (const f of list(tmp)) {
      const p = path.join(tmp, f);
      if (now - (statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? now) > 3_600_000) rmSync(p, { recursive: true, force: true });
    }

    const repos = await Promise.all(list(reposDir).filter((n) => n.endsWith(".git")).map(async (n) => ({ projectId: n.slice(0, -4), bytes: await diskUsage(path.join(reposDir, n)) })));
    const patchesBytes = await diskUsage(path.join(this.root, "patches"));
    const scratchBytes = scratch.reduce((a, s) => a + s.bytes, 0);
    const usedBytes = tickets.reduce((a, t) => a + t.bytes, 0) + repos.reduce((a, r) => a + r.bytes, 0) + patchesBytes + scratchBytes;
    return { usedBytes, tickets, repos, scratch, removed };
  }

  /**
   * Moves leftovers from /tmp into a ticket's kept scratch (BOS-592), where the tmp sweep never reaches them:
   * a proof or log an older run wrote in /tmp survives this runner's restart. Only the top level of /tmp is
   * looked at: a folder that is one of the ticket's own folder names, or a loose file named for the ticket.
   * Returns what it moved. Best effort: a name already in scratch is never overwritten.
   */
  rescueTmp(ticketId: string, tmpDir = "/tmp"): string[] {
    if (!UUID.test(ticketId)) return [];
    const scratch = this.scratchDir(ticketId);
    const id = ticketId.toLowerCase();
    const moved: string[] = [];
    for (const name of existsSync(tmpDir) ? readdirSync(tmpDir) : []) {
      const from = path.join(tmpDir, name);
      const lower = name.toLowerCase();
      // A fenced run writes its check log where it can reach (/tmp) under a kept name, and it lands in scratch as the
      // check's own log: check-all.log for bossman-scratch-<ticket>.log, check-quick.log for the -quick one.
      const checkLog = lower === `bossman-scratch-${id}.log` ? "check-all.log" : lower === `bossman-scratch-${id}-quick.log` ? "check-quick.log" : null;
      const target = path.join(scratch, checkLog ?? name);
      // A kept check log is the one thing the kept folders may already have: never copy one back over it.
      if (name === "check-all.log" || name === "check-quick.log") continue;
      // The check scripts work through /tmp too (it may be another file system), as bossman-scratch-<ticket>.log.
      const mine = checkLog !== null || lower === id || lower.startsWith(`${id}.`) || lower.startsWith(`${id}-`) || lower.startsWith(`${id}_`);
      if (!mine || existsSync(target)) continue;
      // A symlink is never followed nor moved: it could point at another ticket's file, and a link in the scratch
      // would read as that file from the next run on.
      const st = lstatSync(from, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      try {
        mkdirSync(scratch, { recursive: true });
        renameSync(from, target);
        moved.push(name);
      } catch {
        // Another file system (/tmp on its own volume) or a file that moved meanwhile: /tmp goes, so a copy is
        // the only way to keep it.
        try {
          if (st.isDirectory()) cpSync(from, target, { recursive: true });
          else copyFileSync(from, target);
          moved.push(name);
        } catch {
          // Leave it for the sweep.
        }
      }
    }
    return moved;
  }

  /** For tests and the run view: the saved patch, if any. */
  savedPatch(ticketId: string): string | null {
    const f = this.patchFile(ticketId);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  }
}

/** One command line for sh, each word single-quoted (git runs --upload-pack through the shell). */
const shellQuote = (c: { bin: string; args: string[] }) => [c.bin, ...c.args].map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(" ");
