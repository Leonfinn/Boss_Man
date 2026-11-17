// BOS-1645: workspace.mainLog, the runner's read of main's newest first-parent commits, on a real bare origin. The server
// compares them with the merges it recorded, so a merge pushed by someone else (or whose answer was lost) is fetched
// first; a merge's own branch commits are not listed; subjects with odd characters survive; files come only when asked.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const project = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("main's first-parent log on the runner (BOS-1645)", () => {
  it("lists main's merges newest first after a fetch, with time and subject; files only for the commits asked about", async () => {
    const bare = tmp("bm-origin-");
    git(bare, "init", "-q", "--bare", "-b", "main");
    const seed = tmp("bm-seed-");
    git(seed, "clone", "-q", bare, ".");
    writeFileSync(path.join(seed, "a.txt"), "1\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const ws = new Workspaces(tmp("bm-ws-root-"), { ...process.env, BOSSMAN_TICKET_COPIES: "worktree" });
    await ws.ensure({ projectId: project, ticketId: A, repoUrl: bare, baseRef: "main" });

    // After the runner's copy exists, a gate merge lands on main elsewhere: a branch commit, then a --no-ff merge.
    git(seed, "checkout", "-qb", "work");
    writeFileSync(path.join(seed, "apps.txt"), "x\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "branch work, not on the first-parent line");
    git(seed, "checkout", "-q", "main");
    const subject = `Merge "Odd | title \u001f with "quotes"" (${A})`;
    git(seed, "merge", "-q", "--no-ff", "-m", subject, "work");
    git(seed, "push", "-q", "origin", "main");
    const merge = git(seed, "rev-parse", "HEAD");

    const r = await ws.mainLog(project, "main", 50);
    expect(r.commits.map((c) => c.subject)).toEqual([subject, "init"]);
    expect(r.commits[0]!.sha).toBe(merge);
    expect(Number.isNaN(Date.parse(r.commits[0]!.at))).toBe(false);
    expect(r.commits[0]!.files).toBeUndefined();

    const withFiles = await ws.mainLog(project, "main", 1, [merge]);
    expect(withFiles.commits).toHaveLength(1);
    expect(withFiles.commits[0]!.files).toEqual(["apps.txt"]);
    expect(r.commits[0]!.message).toBe(subject);

    // A message with a blank line: the subject is only its first paragraph, so the whole message comes back too (Jane, BOS-1645).
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const twoPart = `Merge "x" (${B})\n\nbar" (${A})`;
    git(seed, "commit", "-q", "--allow-empty", "-m", twoPart);
    git(seed, "push", "-q", "origin", "main");
    const top = (await ws.mainLog(project, "main", 1)).commits[0]!;
    expect(top.subject).toBe(`Merge "x" (${B})`);
    expect(top.message).toBe(twoPart);

    // No copy of the repo, or no such branch: nothing to list, and no error.
    expect(await ws.mainLog("22222222-2222-4222-8222-222222222222", "main", 5)).toEqual({ commits: [] });
    expect(await ws.mainLog(project, "no-such-branch", 5)).toEqual({ commits: [] });
  });
});
