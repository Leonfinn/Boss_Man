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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DiskReport, MergeResult, PushResult, VerifyResult, WorkspaceDiff } from "@boss-man/shared";

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
      const { stdout } = await run("git", ["show", `${branchFor(spec.ticketId)}:${rel}`], { cwd: repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME } as NodeJS.ProcessEnv }).catch(() => {
        throw new Error(`There's no ${rel} on that ticket's branch.`);
      });
      data = stdout as unknown as Buffer;
      from = "branch";
    }
    if (data.includes(0)) throw new Error(`${rel} is a binary file.`);
    const truncated = data.length > maxBytes;
    return { text: data.subarray(0, maxBytes).toString("utf8"), truncated, from };
  }

  async diff(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, maxBytes = 512 * 1024): Promise<WorkspaceDiff> {
    const repo = this.repoDir(spec.projectId);
    const dir = this.ticketDir(spec.ticketId);
    if (!existsSync(path.join(dir, ".git"))) throw new Error("That ticket has no workspace on this runner.");
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
  async checkpoint(spec: Pick<WorkspaceSpec, "projectId" | "ticketId">, label: string): Promise<{ turn: number; commit: string; files: number } | null> {
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
      const who = { GIT_AUTHOR_NAME: "Boss Man", GIT_AUTHOR_EMAIL: "bossman@localhost", GIT_COMMITTER_NAME: "Boss Man", GIT_COMMITTER_EMAIL: "bossman@localhost" };
      const commit = await this.git(["commit-tree", tree, "-p", parent, "-m", `Boss Man checkpoint: ${label}`], { cwd: dir, env: who });
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
   * Runs the ticket's check (e.g. "pnpm test") in its worktree (R47). Output is kept to the
   * last 8 KB. It runs without the company's secrets: a check shouldn't need them.
   */
  async verify(spec: Pick<WorkspaceSpec, "ticketId">, command: string, timeoutMs = 10 * 60_000): Promise<VerifyResult> {
    const dir = this.ticketDir(spec.ticketId);
    if (!existsSync(path.join(dir, ".git"))) throw new Error("That ticket has no workspace on this runner.");
    const started = Date.now();
    try {
      const { stdout, stderr } = await run("sh", ["-c", command], {
        cwd: dir,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { PATH: this.baseEnv.PATH, HOME: this.baseEnv.HOME, CI: "1" } as NodeJS.ProcessEnv,
      });
      return { ok: true, exitCode: 0, timedOut: false, output: `${stdout}${stderr}`.slice(-8192), ms: Date.now() - started };
    } catch (err) {
      const e = err as { code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
      const timedOut = !!e.killed && e.signal === "SIGTERM";
      return { ok: false, exitCode: typeof e.code === "number" ? e.code : null, timedOut, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-8192), ms: Date.now() - started };
    }
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
        const who = { GIT_AUTHOR_NAME: "Boss Man", GIT_AUTHOR_EMAIL: "bossman@localhost", GIT_COMMITTER_NAME: "Boss Man", GIT_COMMITTER_EMAIL: "bossman@localhost" };
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
