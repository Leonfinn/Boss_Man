// R38 against a real local "remote" repo: worktree per ticket, pinned base, patch save and
// restore, serialised creation, and credentials that never touch disk.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

