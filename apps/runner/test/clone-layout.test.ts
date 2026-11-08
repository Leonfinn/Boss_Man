// Per-ticket clones (BOS-323): every workspace and merge test again with BOSSMAN_TICKET_COPIES=clone,
// then what only clones give: one ticket can't reach another's branch or plant config the runner
// runs in another's copy, and the shared repo keeps the objects clones borrow.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { branchFor, isClone, Workspaces } from "../src/workspace.js";

vi.stubEnv("BOSSMAN_TICKET_COPIES", "clone");
afterAll(() => vi.unstubAllEnvs());
await import("./workspace.test.js");
await import("./merge.test.js");
await import("./merge-check.test.js");

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

function remote() {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "v1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "v1");
  return dir;
}

const ids = { project: "11111111-1111-4111-8111-111111111111", a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

/** Two tickets' copies on one runner, made as the runner's setting says. */
async function twoTickets() {
  const url = remote();
  const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
  const spec = (ticketId: string) => ({ projectId: ids.project, ticketId, repoUrl: url, baseRef: "main" });
  const a = await ws.ensure(spec(ids.a));
  const b = await ws.ensure(spec(ids.b));
  return { ws, a, b, spec, repo: ws.repoDir(ids.project) };
}

describe("per-ticket clones (BOS-323)", () => {
  it("makes each copy its own clone, borrowing the shared repo's objects, with origin's branches current", async () => {
    const { a, repo } = await twoTickets();
    expect(isClone(a.path)).toBe(true);
    expect(git(a.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branchFor(ids.a));
    expect(git(a.path, "rev-parse", "origin/main")).toBe(git(repo, "rev-parse", "refs/remotes/origin/main"));
    expect(git(a.path, "remote", "get-url", "origin")).toBe(git(repo, "remote", "get-url", "origin"));
    expect(git(a.path, "rev-parse", "--git-common-dir")).toBe(".git");
    expect(git(repo, "config", "gc.pruneExpire")).toBe("never");
  });

  it("keeps one ticket's branch out of another's reach", async () => {
    const { ws, a, b, spec, repo } = await twoTickets();
    writeFileSync(path.join(b.path, "b.txt"), "b's work\n");
    git(b.path, "add", ".");
    git(b.path, "commit", "-qm", "b's work");
    await ws.checkpoint(spec(ids.b), "after a turn");
    const bHead = git(repo, "rev-parse", `refs/heads/${branchFor(ids.b)}`);

    // From a's copy: delete b's branch, point it somewhere else, and "share" a fake one.
    execFileSync("git", ["update-ref", "-d", `refs/heads/${branchFor(ids.b)}`], { cwd: a.path, stdio: "ignore" });
    execFileSync("sh", ["-c", `git branch -f ${branchFor(ids.b)} HEAD 2>/dev/null; true`], { cwd: a.path });
    await ws.checkpoint(spec(ids.a), "after a turn");

    expect(git(repo, "rev-parse", `refs/heads/${branchFor(ids.b)}`)).toBe(bHead);
    expect(git(b.path, "log", "-1", "--format=%s")).toBe("b's work");
    git(repo, "fsck", "--connectivity-only", "--no-progress");
  });

  it("never runs a filter one ticket sets up when the runner looks at another ticket's copy", async () => {
    const { ws, a, b, spec } = await twoTickets();
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "bm-marker-")), "ran");
    // a's agent sets a clean filter for every path, in the repo config and attributes git reads for its copy.
    git(a.path, "config", "filter.planted.clean", `sh -c 'touch ${marker}; cat'`);
    const common = path.resolve(a.path, git(a.path, "rev-parse", "--git-common-dir"));
    writeFileSync(path.join(common, "info", "attributes"), "* filter=planted\n");

    // The runner records b's turn and makes b's review copy: a's filter must not run for them.
    writeFileSync(path.join(b.path, "b.txt"), "b\n");
    await ws.checkpoint(spec(ids.b), "after a turn");
    await ws.ensureReview({ ...spec(ids.b), review: true });
    await ws.diff(spec(ids.b));
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps objects a clone borrows when the shared repo is cleaned up", async () => {
    const { a, repo } = await twoTickets();
    const borrowed = git(a.path, "rev-parse", "origin/main");
    // Nothing in the shared repo points at that commit any more, as after a force-push to main.
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    for (const ref of git(repo, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean)) git(repo, "update-ref", "-d", ref);
    git(repo, "reflog", "expire", "--all", "--expire=now");
    git(repo, "gc", "--quiet");
    expect(git(a.path, "cat-file", "-t", borrowed)).toBe("commit");
    git(a.path, "fsck", "--connectivity-only", "--no-progress");
  });

  it("refuses to merge rather than merge a stale branch when the clone's branch can't be read", async () => {
    const { ws, a, spec } = await twoTickets();
    git(a.path, "checkout", "-q", "--detach");
    git(a.path, "branch", "-D", branchFor(ids.a));
    await expect(ws.merge(spec(ids.a), "main", "Merge")).rejects.toThrow(/Couldn't bring ticket .* branch over from its copy/);
  });

  it("clears out a clone whose shared repo has gone, but not a live one", async () => {
    const { ws, a, b } = await twoTickets();
    writeFileSync(path.join(b.path, ".git", "objects", "info", "alternates"), "/nonexistent/repos/x.git/objects\n");
    const later = await ws.housekeeping(Date.now() + 2 * 3_600_000);
    expect(later.removed).toEqual([ids.b]);
    expect(existsSync(a.path)).toBe(true);
    expect(later.tickets.map((t) => t.ticketId)).toEqual([ids.a]);
  });
});

describe("turning a ticket's worktree into a clone (BOS-323)", () => {
  /** A ticket worked as a worktree: a commit, then uncommitted, staged, untracked and ignored files, and a turn checkpoint. */
  async function workedWorktree() {
    const url = remote();
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-root-"));
    const as = (copies: string) => new Workspaces(root, { ...process.env, BOSSMAN_TICKET_COPIES: copies });
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: url, baseRef: "main" };
    const old = as("worktree");
    const w = await old.ensure(spec);
    writeFileSync(path.join(w.path, ".gitignore"), "node_modules/\n");
    git(w.path, "add", ".gitignore");
    git(w.path, "commit", "-qm", "ignore packages");
    writeFileSync(path.join(w.path, "README.md"), "edited\n");
    writeFileSync(path.join(w.path, "staged.txt"), "staged\n");
    git(w.path, "add", "staged.txt");
    writeFileSync(path.join(w.path, "untracked.txt"), "untracked\n");
    mkdirSync(path.join(w.path, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(w.path, "node_modules", "pkg", "index.js"), "installed\n");
    await old.checkpoint(spec, "after a turn");
    const repo = old.repoDir(ids.project);
    const admin = path.resolve(w.path, readFileSync(path.join(w.path, ".git"), "utf8").replace("gitdir:", "").trim());
    return { as, spec, w, repo, admin, head: git(w.path, "rev-parse", "HEAD") };
  }

  const expectEveryFileKept = (dir: string) => {
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("edited\n");
    expect(readFileSync(path.join(dir, "staged.txt"), "utf8")).toBe("staged\n");
    expect(readFileSync(path.join(dir, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "utf8")).toBe("installed\n");
  };

  it("keeps every file, the branch and the checkpoints, and lets go of the worktree", async () => {
    const { as, spec, w, repo, admin, head } = await workedWorktree();
    const ws = as("clone");
    expect(await ws.ensure(spec)).toMatchObject({ path: w.path, created: false, branch: branchFor(ids.a) });
    expect(isClone(w.path)).toBe(true);
    expectEveryFileKept(w.path);
    expect(git(w.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branchFor(ids.a));
    // The only difference: what was staged is now just changed.
    expect(git(w.path, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? staged.txt", "?? untracked.txt", "M README.md"]);
    expect(existsSync(admin)).toBe(false);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect((await ws.lastTurnDiff(spec)).turn).toMatchObject({ number: 1 });
    // And it works as a clone from here on.
    git(w.path, "add", ".");
    git(w.path, "commit", "-qm", "after the move");
    expect(await ws.pushForReview(spec, "main")).toMatchObject({ status: "pushed" });
    expect(git(spec.repoUrl, "log", "-1", "--format=%s", branchFor(ids.a))).toBe("after the move");
  });

  it("finishes a conversion cut short between moving the old .git aside and putting the new one in", async () => {
    const { as, spec, w, repo } = await workedWorktree();
    git(repo, "worktree", "lock", w.path);
    renameSync(path.join(w.path, ".git"), path.join(w.path, ".git.bossman-converting"));
    // Housekeeping leaves it alone meanwhile.
    expect((await as("clone").housekeeping(Date.now() + 2 * 3_600_000)).removed).toEqual([]);
    await as("clone").ensure(spec);
    expect(isClone(w.path)).toBe(true);
    expect(existsSync(path.join(w.path, ".git.bossman-converting"))).toBe(false);
    expectEveryFileKept(w.path);
  });

  it("never clears a conversion cut short as a half-made folder when a check reopens it first (BOS-634 merge)", async () => {
    const { as, spec, w, repo } = await workedWorktree();
    git(repo, "worktree", "lock", w.path);
    renameSync(path.join(w.path, ".git"), path.join(w.path, ".git.bossman-converting"));
    for (const kind of ["worktree", "clone"] as const) await expect(as(kind).diff(spec)).rejects.toThrow();
    expectEveryFileKept(w.path);
    await as("clone").ensure(spec);
    expect(isClone(w.path)).toBe(true);
    expectEveryFileKept(w.path);
  });

  it("finishes a conversion cut short before the index was rebuilt", async () => {
    const { as, spec, w, admin } = await workedWorktree();
    const pointer = readFileSync(path.join(w.path, ".git"), "utf8");
    await as("clone").ensure(spec);
    // As if it stopped right after the swap: old .git aside, its admin folder still there, no index.
    writeFileSync(path.join(w.path, ".git.bossman-converting"), pointer);
    mkdirSync(admin, { recursive: true });
    writeFileSync(path.join(admin, "gitdir"), path.join(w.path, ".git") + "\n");
    rmSync(path.join(w.path, ".git", "index"));
    await as("clone").ensure(spec);
    expect(existsSync(path.join(w.path, ".git.bossman-converting"))).toBe(false);
    expect(existsSync(admin)).toBe(false);
    expect(git(w.path, "status", "--porcelain")).not.toContain("D ");
  });

  it("never deletes another ticket's worktree admin folder, whatever pointer the agent leaves in the aside file", async () => {
    const { as, spec, w } = await workedWorktree();
    // A second ticket's worktree on the same runner: its admin folder is the victim.
    const other = { ...spec, ticketId: ids.b };
    const o = await as("worktree").ensure(other);
    const victim = path.resolve(o.path, readFileSync(path.join(o.path, ".git"), "utf8").replace("gitdir:", "").trim());
    await as("clone").ensure(spec);
    // The agent (now in a clone) plants a pointer at the victim's admin folder, as if a conversion were cut short.
    writeFileSync(path.join(w.path, ".git.bossman-converting"), `gitdir: ${victim}\n`);
    await as("clone").ensure(spec);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(path.join(w.path, ".git.bossman-converting"))).toBe(false);
    expect(git(o.path, "status", "--porcelain")).toBe("");
  });

  it("leaves worktrees as they are while new copies are worktrees, and puts back one cut short", async () => {
    const { as, spec, w, repo } = await workedWorktree();
    await as("worktree").ensure(spec);
    expect(isClone(w.path)).toBe(false);
    git(repo, "worktree", "lock", w.path);
    renameSync(path.join(w.path, ".git"), path.join(w.path, ".git.bossman-converting"));
    await as("worktree").ensure(spec);
    expect(isClone(w.path)).toBe(false);
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branchFor(ids.a));
    expectEveryFileKept(w.path);
    // Unlocked again, so releasing it works as before.
    expect(await as("worktree").release(spec)).toEqual({ savedPatch: true });
  });
});
