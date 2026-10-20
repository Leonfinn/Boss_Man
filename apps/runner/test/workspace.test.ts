// R38 against a real local "remote" repo: worktree per ticket, pinned base, patch save and
// restore, serialised creation, and credentials that never touch disk.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { branchFor, gitAuthEnv, Workspaces } from "../src/workspace.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function remote() {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "v1\n");
  writeFileSync(path.join(dir, ".gitignore"), ".env\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "v1");
  // An ignored local file in the source must never reach a workspace.
  writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
  return { dir, commit: (msg: string) => (writeFileSync(path.join(dir, "README.md"), `${msg}\n`), git(dir, "commit", "-qam", msg), git(dir, "rev-parse", "HEAD")) };
}

const ids = { project: "11111111-1111-4111-8111-111111111111", a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

describe("git workspaces (R38)", () => {
  it("makes a worktree per ticket on its own branch from a pinned base, and never recreates it", async () => {
    const r = remote();
    const base = git(r.dir, "rev-parse", "HEAD");
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };

    const first = await ws.ensure(spec);
    expect(first).toMatchObject({ created: true, baseCommit: base, branch: branchFor(ids.a), restoredPatch: false });
    expect(git(first.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`bossman/${ids.a}`);
    expect(existsSync(path.join(first.path, ".env"))).toBe(false);

    // The remote moves on; the existing worktree and its base stay put.
    r.commit("v2");
    writeFileSync(path.join(first.path, "work.txt"), "in progress\n");
    const again = await ws.ensure(spec);
    expect(again).toMatchObject({ created: false, baseCommit: base });
    expect(readFileSync(path.join(again.path, "work.txt"), "utf8")).toBe("in progress\n");
  });

  it("saves uncommitted work as a patch on release and puts it back next time", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const w = await ws.ensure(spec);
    writeFileSync(path.join(w.path, "README.md"), "edited\n");
    writeFileSync(path.join(w.path, "new-file.txt"), "untracked\n");
    git(w.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "agent commit");
    writeFileSync(path.join(w.path, "README.md"), "edited again\n");
    writeFileSync(path.join(w.path, ".env"), "IGNORED=1\n");

    expect(await ws.release(spec)).toEqual({ savedPatch: true });
    expect(existsSync(w.path)).toBe(false);
    const patch = ws.savedPatch(ids.a)!;
    expect(patch).toContain("new-file.txt");
    expect(patch).not.toContain("IGNORED");

    const back = await ws.ensure(spec);
    expect(back).toMatchObject({ created: true, restoredPatch: true, baseCommit: w.baseCommit });
    // The branch kept its commit, and the uncommitted changes came back on top.
    expect(git(back.path, "log", "-1", "--format=%s")).toBe("agent commit");
    expect(readFileSync(path.join(back.path, "README.md"), "utf8")).toBe("edited again\n");
    expect(readFileSync(path.join(back.path, "new-file.txt"), "utf8")).toBe("untracked\n");
    expect(ws.savedPatch(ids.a)).toBeNull();
  });

  it("serialises concurrent creation on one repo", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const [a, b] = await Promise.all([
      ws.ensure({ projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" }),
      ws.ensure({ projectId: ids.project, ticketId: ids.b, repoUrl: r.dir, baseRef: "main" }),
    ]);
    expect(a.created && b.created).toBe(true);
    expect(git(ws.repoDir(ids.project), "worktree", "list").split("\n")).toHaveLength(3);
  });

  it("passes a git token through the environment only", () => {
    const env = gitAuthEnv({ GIT_TOKEN: "ghp_x" });
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader" });
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.replace("Authorization: Basic ", ""), "base64").toString()).toBe("x-access-token:ghp_x");
    expect(gitAuthEnv({})).toEqual({ GIT_TERMINAL_PROMPT: "0" });
  });

  it("reports a clone that fails", async () => {
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    await expect(ws.ensure({ projectId: ids.project, ticketId: ids.a, repoUrl: "/nonexistent/repo", baseRef: "main" })).rejects.toThrow();
  });

  it("diffs a ticket against its base: commits, uncommitted and untracked work, without touching the agent's index", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const w = await ws.ensure(spec);
    writeFileSync(path.join(w.path, "README.md"), "v1\nmore\n");
    git(w.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "Add a line");
    writeFileSync(path.join(w.path, "src.ts"), "export const x = 1;\n");
    writeFileSync(path.join(w.path, "README.md"), "v1\nmore\nand more\n");
    writeFileSync(path.join(w.path, ".env"), "SECRET=1\n");
    git(w.path, "add", "README.md");
    const stagedBefore = git(w.path, "diff", "--cached", "--name-only");

    const d = await ws.diff(spec);
    expect(d.baseCommit).toBe(w.baseCommit);
    expect(d.commits.map((c) => c.subject)).toEqual(["Add a line"]);
    expect(d.files).toEqual(expect.arrayContaining([{ path: "README.md", added: 2, removed: 0 }, { path: "src.ts", added: 1, removed: 0 }]));
    expect(d.files.map((f) => f.path)).not.toContain(".env");
    expect(d.diff).toContain("+and more");
    expect(d.truncated).toBe(false);
    // The agent's own staging area is exactly as it was.
    expect(git(w.path, "diff", "--cached", "--name-only")).toBe(stagedBefore);
    expect((await ws.diff(spec, 50)).truncated).toBe(true);
  });
});

describe("reading another ticket's files (R77)", () => {
  it("reads from the worktree while it's there, from the branch once it's released, and refuses paths outside the repo", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const w = await ws.ensure(spec);
    mkdirSync(path.join(w.path, "docs"), { recursive: true });
    writeFileSync(path.join(w.path, "docs", "research.md"), "# Findings\n");
    expect(await ws.readFile(spec, "docs/research.md")).toEqual({ text: "# Findings\n", truncated: false, from: "worktree" });
    // A symlink out of the worktree isn't followed; there's no such file on the branch either.
    symlinkSync("/etc/hostname", path.join(w.path, "escape.txt"));
    await expect(ws.readFile(spec, "escape.txt")).rejects.toThrow("There's no escape.txt on that ticket's branch.");
    rmSync(path.join(w.path, "escape.txt"));
    git(w.path, "add", ".");
    git(w.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "research");
    await ws.release(spec);
    expect(await ws.readFile(spec, "docs/research.md")).toEqual({ text: "# Findings\n", truncated: false, from: "branch" });
    await expect(ws.readFile(spec, "docs/missing.md")).rejects.toThrow("There's no docs/missing.md on that ticket's branch.");
    await expect(ws.readFile(spec, "../../etc/passwd")).rejects.toThrow("isn't a path inside the repository");
    await expect(ws.readFile(spec, "--output=x")).rejects.toThrow("isn't a path inside the repository");
  });
});

describe("workspace clean-up (R54)", () => {
  it("prunes worktrees whose folder went, removes folders git doesn't know, and reports disk use", async () => {
    const r = remote();
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-root-"));
    const ws = new Workspaces(root);
    const a = await ws.ensure({ projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" });
    const b = await ws.ensure({ projectId: ids.project, ticketId: ids.b, repoUrl: r.dir, baseRef: "main" });
    writeFileSync(path.join(a.path, "big.bin"), Buffer.alloc(256 * 1024, 1));
    // b's folder vanishes behind git's back, then something unrelated appears in tickets/.
    rmSync(b.path, { recursive: true, force: true });
    const stray = path.join(root, "tickets", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    mkdirSync(stray, { recursive: true });
    writeFileSync(path.join(stray, "leftover.txt"), "x");
    mkdirSync(path.join(root, "tmp"), { recursive: true });
    writeFileSync(path.join(root, "tmp", "old.index"), "x");

    // Fresh folders are left alone in case a worktree is being made right now.
    expect((await ws.housekeeping()).removed).toEqual([]);
    expect(existsSync(stray)).toBe(true);

    const later = await ws.housekeeping(Date.now() + 2 * 3_600_000);
    expect(later.removed).toEqual(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(path.join(root, "tmp", "old.index"))).toBe(false);
    expect(git(ws.repoDir(ids.project), "worktree", "list")).not.toContain(ids.b);
    expect(later.tickets).toEqual([{ ticketId: ids.a, projectId: ids.project, bytes: expect.any(Number) }]);
    // Allocated size, as the filesystem reports it: ZFS compresses and allocates late, so 256 KB
    // written can show as almost nothing for a while.
    expect(later.tickets[0]!.bytes).toBeGreaterThanOrEqual(statSync(path.join(a.path, "big.bin")).blocks * 512);
    expect(later.repos).toEqual([{ projectId: ids.project, bytes: expect.any(Number) }]);
    expect(later.usedBytes).toBe(later.tickets[0]!.bytes + later.repos[0]!.bytes);
    // The ticket's branch survives its worktree.
    expect(git(ws.repoDir(ids.project), "branch", "--list", branchFor(ids.b))).toContain(ids.b);
  });
});

describe("turn checkpoints (R39)", () => {
  it("records each turn under private refs without touching the agent's branch or index, and diffs the last turn", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const w = await ws.ensure(spec);
    const head = git(w.path, "rev-parse", "HEAD");

    // Before the run: nothing changed from HEAD, so nothing is recorded.
    expect(await ws.checkpoint(spec, "before the run")).toBeNull();
    await expect(ws.lastTurnDiff(spec)).rejects.toThrow("No turn has changed anything yet.");

    // Turn 1: an edit and a new file, one of them staged by the agent.
    writeFileSync(path.join(w.path, "README.md"), "turn one\n");
    writeFileSync(path.join(w.path, "a.txt"), "a\n");
    git(w.path, "add", "a.txt");
    expect(await ws.checkpoint(spec, "after a turn")).toMatchObject({ turn: 1, files: 2 });
    // Turn 2: another file; a turn that changes nothing records nothing.
    writeFileSync(path.join(w.path, "b.txt"), "b\n");
    writeFileSync(path.join(w.path, ".env"), "IGNORED=1\n");
    expect(await ws.checkpoint(spec, "after a turn")).toMatchObject({ turn: 2, files: 1 });
    expect(await ws.checkpoint(spec, "after a turn")).toBeNull();

    const d = await ws.lastTurnDiff(spec);
    expect(d.files).toEqual([{ path: "b.txt", added: 1, removed: 0 }]);
    expect(d.turn).toMatchObject({ number: 2 });
    expect(d.diff).not.toContain(".env");

    // The agent's branch, index and files are as it left them.
    expect(git(w.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(w.path, "diff", "--cached", "--name-only")).toBe("a.txt");
    expect(git(w.path, "status", "--porcelain")).toContain("?? b.txt");
    expect(git(ws.repoDir(ids.project), "for-each-ref", "--format=%(refname)", `refs/bossman/checkpoints/${ids.a}/`).split("\n")).toHaveLength(2);


    // A change made between runs is caught by the next run's "before" checkpoint, not shown as a turn.
    writeFileSync(path.join(w.path, "c.txt"), "by hand\n");
    expect(await ws.checkpoint(spec, "before the run")).toMatchObject({ turn: 3 });
    expect((await ws.lastTurnDiff(spec)).files.map((f) => f.path)).toEqual(["b.txt"]);
    writeFileSync(path.join(w.path, "b.txt"), "b2\n");
    expect(await ws.checkpoint(spec, "after a turn")).toMatchObject({ turn: 4, files: 1 });
    expect((await ws.lastTurnDiff(spec)).files).toEqual([{ path: "b.txt", added: 1, removed: 1 }]);

    // Released: the checkpoints go with the worktree.
    await ws.release(spec);
    expect(git(ws.repoDir(ids.project), "for-each-ref", `refs/bossman/checkpoints/${ids.a}/`)).toBe("");
  });
});
