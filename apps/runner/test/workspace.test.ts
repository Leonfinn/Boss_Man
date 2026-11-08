// R38 against a real local "remote" repo: worktree per ticket, pinned base, patch save and
// restore, serialised creation, and credentials that never touch disk.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASED_SCRATCH_KEEP_MS, SCRATCH_KEEP_MS } from "@boss-man/shared";
import { branchFor, gitAuthEnv, isClone, safeGitEnv, Workspaces } from "../src/workspace.js";

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

  it("recovers by itself when the ticket's branch is checked out in another ticket's folder, or a half-made folder is in the way (BOS-634)", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const specA = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const specB = { projectId: ids.project, ticketId: ids.b, repoUrl: r.dir, baseRef: "main" };
    const a = await ws.ensure(specA);
    const b = await ws.ensure(specB);
    git(a.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "work on A");
    await ws.release(specA);
    // An agent working on B switches B's folder onto A's branch, so A's branch is taken. A clone
    // (BOS-323) has no other ticket's branch to switch to, so only the half-made folder applies.
    const worktrees = !isClone(b.path);
    if (worktrees) {
      git(b.path, "switch", "-q", branchFor(ids.a));
      writeFileSync(path.join(b.path, "b-note.txt"), "uncommitted\n");
    }
    // A half-made folder for A is in the way as well.
    mkdirSync(ws.ticketDir(ids.a), { recursive: true });
    writeFileSync(path.join(ws.ticketDir(ids.a), "junk"), "x");

    const back = await ws.ensure(specA);
    expect(back.created).toBe(true);
    expect(git(back.path, "log", "-1", "--format=%s")).toBe("work on A");
    expect(git(back.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branchFor(ids.a));
    // B's folder keeps its files and uncommitted work, now on a detached HEAD.
    if (worktrees) {
      expect(git(b.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      expect(readFileSync(path.join(b.path, "b-note.txt"), "utf8")).toBe("uncommitted\n");
    }
  });

  it("does not run hooks or a filesystem monitor named in the shared repo's config", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const specA = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    await ws.ensure(specA);
    const evil = mkdtempSync(path.join(tmpdir(), "bm-evil-"));
    const marker = path.join(evil, "ran");
    mkdirSync(path.join(evil, "hooks"));
    for (const hook of ["post-checkout", "reference-transaction"]) {
      writeFileSync(path.join(evil, "hooks", hook), `#!/bin/sh\necho ${hook} >> ${marker}\n`, { mode: 0o755 });
    }
    writeFileSync(path.join(evil, "fsmonitor"), `#!/bin/sh\necho fsmonitor >> ${marker}\n`, { mode: 0o755 });
    git(ws.repoDir(ids.project), "config", "core.hooksPath", path.join(evil, "hooks"));
    git(ws.repoDir(ids.project), "config", "core.fsmonitor", path.join(evil, "fsmonitor"));

    const specB = { ...specA, ticketId: ids.b };
    const b = await ws.ensure(specB);
    writeFileSync(path.join(b.path, "x.txt"), "x\n");
    await ws.release(specB);
    expect(existsSync(marker)).toBe(false);
  });

  it("serialises concurrent creation on one repo", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const [a, b] = await Promise.all([
      ws.ensure({ projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" }),
      ws.ensure({ projectId: ids.project, ticketId: ids.b, repoUrl: r.dir, baseRef: "main" }),
    ]);
    expect(a.created && b.created).toBe(true);
    if (isClone(a.path)) expect([a.path, b.path].map((p) => git(p, "rev-parse", "--abbrev-ref", "HEAD"))).toEqual([branchFor(ids.a), branchFor(ids.b)]);
    else expect(git(ws.repoDir(ids.project), "worktree", "list").split("\n")).toHaveLength(3);
  });

  it("lets seven runs start at once on one repo and all get a workspace", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const tickets = Array.from({ length: 7 }, (_, i) => `${i}0000000-0000-4000-8000-000000000000`);
    const made = await Promise.all(tickets.map((ticketId) => ws.ensure({ projectId: ids.project, ticketId, repoUrl: r.dir, baseRef: "main" })));
    expect(made.every((m) => m.created)).toBe(true);
    if (isClone(made[0]!.path)) expect(made.every((m) => isClone(m.path))).toBe(true);
    else expect(git(ws.repoDir(ids.project), "worktree", "list").split("\n")).toHaveLength(8);
  });

  it("passes a git token through the environment only", () => {
    const env = gitAuthEnv({ GIT_TOKEN: "ghp_x" });
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader" });
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.replace("Authorization: Basic ", ""), "base64").toString()).toBe("x-access-token:ghp_x");
    expect(gitAuthEnv({})).toEqual({ GIT_TERMINAL_PROMPT: "0" });
  });

  it("keeps the hook and fsmonitor settings when a git token adds its own config entry", () => {
    const env = safeGitEnv(gitAuthEnv({ GIT_TOKEN: "ghp_x" }));
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: "5",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "credential.helper",
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: "commit.gpgSign",
      GIT_CONFIG_VALUE_3: "false",
      GIT_CONFIG_KEY_4: "http.extraHeader",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env.GIT_CONFIG_VALUE_4).toMatch(/^Authorization: Basic /);
    expect(safeGitEnv(gitAuthEnv({}))).toMatchObject({ GIT_CONFIG_COUNT: "4" });
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

  it("measures a review diff from the merge-base with current main, so a branch that merged main shows only its own changes (BOS-694)", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const w = await ws.ensure(spec);
    // The ticket's own commit.
    writeFileSync(path.join(w.path, "ticket.txt"), "ours\n");
    git(w.path, "add", "ticket.txt");
    git(w.path, "commit", "-qm", "Ticket work");
    // Main moves on a long way after the branch started.
    for (let i = 0; i < 5; i++) r.commit(`main ${i + 2}`);
    const mainTip = git(r.dir, "rev-parse", "HEAD");
    // The agent merges main in, so the recorded base is now hundreds of commits behind the branch.
    git(w.path, "fetch", "-q", "origin");
    git(w.path, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", mainTip);

    // Without a base ref the diff is still the old recorded-base one: it sees main's work too.
    const stale = await ws.diff(spec);
    expect(stale.files.map((f) => f.path)).toContain("README.md");

    // With the default branch, it is the branch's own changes, the same file list as `origin/main...HEAD`.
    const d = await ws.diff(spec, undefined, "main");
    const byHand = git(w.path, "diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean).sort();
    expect(d.files.map((f) => f.path).sort()).toEqual(byHand);
    expect(d.files.map((f) => f.path)).toEqual(["ticket.txt"]);
    // The branch's own commits: its work and the merge that brought main in, but none of main's own commits.
    expect(d.commits.map((c) => c.subject).filter((s) => !s.startsWith("Merge"))).toEqual(["Ticket work"]);
    expect(d.commits.map((c) => c.subject)).not.toContain("main 5");
    // The base is now the merge-base with main, not the ticket's stale recorded start.
    expect(d.baseCommit).toBe(git(w.path, "merge-base", "origin/main", "HEAD"));
    expect(d.baseCommit).not.toBe(w.baseCommit);
  });

  it("falls back to the recorded base when the default branch can't be fetched", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const w = await ws.ensure(spec);
    writeFileSync(path.join(w.path, "ticket.txt"), "ours\n");
    git(w.path, "add", "ticket.txt");
    git(w.path, "commit", "-qm", "Ticket work");
    // origin/<baseRef> can't be resolved: the diff still answers from the recorded base.
    const d = await ws.diff(spec, undefined, "no-such-branch");
    expect(d.baseCommit).toBe(w.baseCommit);
    expect(d.files.map((f) => f.path)).toEqual(["ticket.txt"]);
  });

  it("reports the tree of the head it read, even when a commit lands mid-diff", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const w = await ws.ensure(spec);
    const headA = git(w.path, "rev-parse", "HEAD");
    const treeA = git(w.path, "rev-parse", "HEAD^{tree}");
    // A commit lands right after the head is read (during the slow steps).
    const real = (ws as any).git.bind(ws);
    let landed = false;
    (ws as any).git = async (args: string[], opts?: unknown) => {
      const out = await real(args, opts);
      if (!landed && args[0] === "rev-parse" && args[1] === "HEAD") {
        landed = true;
        writeFileSync(path.join(w.path, "later.txt"), "B\n");
        git(w.path, "add", "later.txt");
        git(w.path, "commit", "-qm", "later");
      }
      return out;
    };
    const d = await ws.diff(spec);
    expect(landed).toBe(true);
    expect(d.head).toBe(headA);
    expect(d.tree).toBe(treeA);
  });
});

describe("a reviewer's own copy", () => {
  it("copies the ticket's latest work, uncommitted included, keeps the reviewer's changes out of the ticket, and goes when the ticket is released", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const dev = await ws.ensure(spec);
    writeFileSync(path.join(dev.path, "README.md"), "uncommitted\n");
    writeFileSync(path.join(dev.path, "new.txt"), "untracked\n");

    const copy = await ws.ensureReview({ ...spec, review: true });
    expect(copy.path).not.toBe(dev.path);
    expect(readFileSync(path.join(copy.path, "README.md"), "utf8")).toBe("uncommitted\n");
    expect(readFileSync(path.join(copy.path, "new.txt"), "utf8")).toBe("untracked\n");
    // The developer's branch, index and files are as they were.
    expect(git(dev.path, "status", "--porcelain")).toContain("new.txt");
    expect(git(dev.path, "rev-parse", "HEAD")).toBe(dev.baseCommit);

    // The reviewer's edits stay in its copy, and the next review starts from the latest work again.
    writeFileSync(path.join(copy.path, "README.md"), "reviewer was here\n");
    writeFileSync(path.join(copy.path, "scratch.txt"), "x\n");
    expect(readFileSync(path.join(dev.path, "README.md"), "utf8")).toBe("uncommitted\n");
    writeFileSync(path.join(dev.path, "README.md"), "second round\n");
    const again = await ws.ensureReview({ ...spec, review: true });
    expect(readFileSync(path.join(again.path, "README.md"), "utf8")).toBe("second round\n");
    expect(existsSync(path.join(again.path, "scratch.txt"))).toBe(false);

    await ws.release(spec);
    expect(existsSync(copy.path)).toBe(false);
    // With the worktree gone, a review copy comes from the ticket's branch.
    expect(readFileSync(path.join((await ws.ensureReview({ ...spec, review: true })).path, "README.md"), "utf8")).toBe("v1\n");
  });

  it("refuses a ticket with no work here", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    await expect(ws.ensureReview({ projectId: ids.project, ticketId: ids.b, repoUrl: r.dir, baseRef: "main", review: true })).rejects.toThrow(/no work on this runner/);
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

describe("kept scratch per ticket (BOS-592)", () => {
  it("keeps a ticket's scratch on the workspaces disk, clears it once its work is released and old, and otherwise after a week", async () => {
    const r = remote();
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-root-"));
    const ws = new Workspaces(root);
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const w = await ws.ensure(spec);
    const scratch = ws.scratchDir(ids.a);
    expect(scratch).toBe(path.join(root, "scratch", ids.a));
    expect(scratch.startsWith(path.join(root, "scratch"))).toBe(true);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, "proof.log"), "the whole check\n");

    // A restart is a new process: scratch is on the disk, not in /tmp, so it is still there.
    const again = new Workspaces(root);
    expect(readFileSync(path.join(again.scratchDir(ids.a), "proof.log"), "utf8")).toBe("the whole check\n");

    // While the ticket still has its worktree, only the week clears it (here: past the week).
    const fresh = await again.housekeeping();
    expect(fresh.scratch).toEqual([{ ticketId: ids.a, bytes: expect.any(Number) }]);
    expect(existsSync(scratch)).toBe(true);
    const week = await again.housekeeping(Date.now() + SCRATCH_KEEP_MS + 1000);
    expect(week.removed).toContain(ids.a);
    expect(existsSync(scratch)).toBe(false);

    // The ticket's work goes: its scratch goes with it, but only once it is old enough that a run can't be writing.
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, "old-proof.log"), "x");
    await again.release(spec);
    expect(existsSync(scratch)).toBe(true);
    const released = await again.housekeeping(Date.now() + RELEASED_SCRATCH_KEEP_MS + 1000);
    expect(released.removed).toContain(ids.a);
    expect(existsSync(scratch)).toBe(false);
  });

  it("only ever touches per-ticket folders of its own scratch, and counts them as used disk", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-root-"));
    const ws = new Workspaces(root);
    const mine = ws.scratchDir(ids.a);
    mkdirSync(mine, { recursive: true });
    writeFileSync(path.join(mine, "big.bin"), Buffer.alloc(64 * 1024, 1));
    // Anything else in the folder (a stray name, a file) is left exactly as it is.
    mkdirSync(path.join(root, "scratch", "not-a-ticket"));
    writeFileSync(path.join(root, "scratch", "not-a-ticket", "keep.txt"), "x");
    writeFileSync(path.join(root, "scratch", "loose.txt"), "x");
    const kept = await ws.housekeeping();
    expect(kept.scratch).toEqual([{ ticketId: ids.a, bytes: expect.any(Number) }]);
    expect(kept.usedBytes).toBeGreaterThanOrEqual(kept.scratch![0]!.bytes);
    expect(kept.removed).toEqual([]);
    const report = await ws.housekeeping(Date.now() + 8 * 24 * 3_600_000);
    expect(existsSync(path.join(root, "scratch", "not-a-ticket", "keep.txt"))).toBe(true);
    expect(existsSync(path.join(root, "scratch", "loose.txt"))).toBe(true);
    expect(report.removed).toEqual([ids.a]);
    expect(report.scratch).toEqual([]);
    expect(existsSync(mine)).toBe(false);
  });

  it("moves a ticket's own /tmp leftovers into its scratch, once, without following links or overwriting a kept file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-root-"));
    const ws = new Workspaces(root);
    const tmp = mkdtempSync(path.join(tmpdir(), "bm-tmp-"));
    const scratch = ws.scratchDir(ids.a);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, "check-all.log"), "kept\n");
    mkdirSync(path.join(tmp, ids.a));
    writeFileSync(path.join(tmp, ids.a, "proof.txt"), "proof\n");
    writeFileSync(path.join(tmp, `${ids.a}.log`), "log\n");
    writeFileSync(path.join(tmp, "check-all.log"), "another ticket's log\n");
    writeFileSync(path.join(tmp, "someone-else.log"), "not mine\n");
    symlinkSync("/etc/hostname", path.join(tmp, `${ids.a}.link`));

    expect(ws.rescueTmp(ids.a, tmp).sort()).toEqual([ids.a, `${ids.a}.log`].sort());
    expect(readFileSync(path.join(scratch, ids.a, "proof.txt"), "utf8")).toBe("proof\n");
    expect(readFileSync(path.join(scratch, `${ids.a}.log`), "utf8")).toBe("log\n");
    expect(readFileSync(path.join(scratch, "check-all.log"), "utf8")).toBe("kept\n");
    expect(existsSync(path.join(tmp, "someone-else.log"))).toBe(true);
    expect(existsSync(path.join(tmp, `${ids.a}.link`))).toBe(true);
    expect(ws.rescueTmp("../etc", tmp)).toEqual([]);
  });

  it("finds an image saved in the kept scratch as the ticket's own", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-root-"));
    const ws = new Workspaces(root);
    expect(() => ws.readImage(ids.a, "shot.png")).toThrow();
    const scratch = ws.scratchDir(ids.a);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(path.join(scratch, "shot.png"), "png-bytes");
    expect(ws.readImage(ids.a, "shot.png").base64).toBe(Buffer.from("png-bytes").toString("base64"));
  });
});

describe("the git author a rename asks for (BOS-265)", () => {
  it("signs a turn's checkpoint with the agent's current name, and keeps Boss Man's own commits as Boss Man", async () => {
    const r = remote();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: r.dir, baseRef: "main" };
    const w = await ws.ensure(spec);
    writeFileSync(path.join(w.path, "a.txt"), "a\n");
    await ws.checkpoint(spec, "after a turn", "Zippy");
    const head = git(ws.repoDir(ids.project), "rev-parse", "refs/bossman/checkpoints/" + ids.a + "/000001");
    expect(git(ws.repoDir(ids.project), "log", "-1", "--format=%an <%ae>|%cn", head)).toBe("Zippy <bossman@localhost>|Zippy");
    // No name sent (an older server), or a blank one: Boss Man signs, never an empty author.
    writeFileSync(path.join(w.path, "b.txt"), "b\n");
    await ws.checkpoint(spec, "after a turn", "  ");
    const next = git(ws.repoDir(ids.project), "rev-parse", "refs/bossman/checkpoints/" + ids.a + "/000002");
    expect(git(ws.repoDir(ids.project), "log", "-1", "--format=%an", next)).toBe("Boss Man");
    // A reviewer's copy is Boss Man's snapshot of the work, not the agent's commit.
    const rev = await ws.ensureReview(spec);
    expect(git(ws.repoDir(ids.project), "log", "-1", "--format=%an %s", rev.commit)).toBe("Boss Man Boss Man review copy");
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

describe("images for a ticket", () => {
  it("reads a screenshot from the ticket's worktree or plain working folder, never outside them, and caps the size", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-img-"));
    const ws = new Workspaces(root);
    const withRepo = "11111111-1111-4111-8111-111111111111";
    const plain = "22222222-2222-4222-8222-222222222222";
    mkdirSync(path.join(ws.ticketDir(withRepo), "shots"), { recursive: true });
    writeFileSync(path.join(ws.ticketDir(withRepo), "shots", "a.png"), "png bytes");
    mkdirSync(path.join(root, plain), { recursive: true });
    writeFileSync(path.join(root, plain, "b.png"), "more bytes");
    writeFileSync(path.join(root, "secret.txt"), "not yours");
    symlinkSync(path.join(root, "secret.txt"), path.join(root, plain, "link.png"));

    expect(ws.readImage(withRepo, "shots/a.png")).toEqual({ base64: Buffer.from("png bytes").toString("base64"), size: 9 });
    expect(ws.readImage(plain, path.join(root, plain, "b.png")).size).toBe(10);
    expect(() => ws.readImage(plain, "link.png")).toThrow("There's no link.png");
    expect(() => ws.readImage(plain, "../secret.txt")).toThrow("There's no ../secret.txt");
    expect(() => ws.readImage(plain, path.join(root, "secret.txt"))).toThrow("There's no");
    expect(() => ws.readImage(plain, "b.png", 4)).toThrow("images are limited to");
  });
});
