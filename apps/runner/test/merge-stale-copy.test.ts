// BOS-1231: a ticket's copy that fell behind its own branch. On 11 Nov Basil (BOS-1128) and Rosalie (BOS-1130) checked
// their ticket's branch out in another ticket's folder, fast-forwarded it to main and committed there. Their own folders
// still pointed at the branch but kept the old base's files, so `git status` there listed main's newer files (and their
// own test file as deleted), and the merge told them to commit all of it. Real git, a bare origin, worktree copies.
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

const ids = { project: "11111111-1111-4111-8111-111111111111", mine: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

/**
 * Today's shape: ticket "mine" and another ticket each have a copy; main then moves; the agent, in the other ticket's
 * folder, checks out mine's branch, merges main and commits its test there, then goes back to the other branch.
 */
async function staleCopy() {
  const bare = tmp("bm-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-seed-");
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "app.txt"), "app v1\n");
  writeFileSync(path.join(seed, "launcher.ts"), "launcher v1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");

  const ws = new Workspaces(tmp("bm-ws-root-"));
  const spec = { projectId: ids.project, ticketId: ids.mine, repoUrl: bare, baseRef: "main" };
  const mine = await ws.ensure(spec);
  const other = await ws.ensure({ ...spec, ticketId: ids.other });

  // Other tickets merge into main: a changed file and a new one.
  writeFileSync(path.join(seed, "launcher.ts"), "launcher v2\n");
  writeFileSync(path.join(seed, "check-limit.ts"), "new on main\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "other tickets' work");
  git(seed, "push", "-q", "origin", "HEAD:main");
  await ws.ensure({ ...spec, ticketId: ids.other }); // run start: the shared repo fetches main

  // The agent works on mine's branch from the other ticket's folder (BOS-1120: a run that started in the wrong place).
  git(other.path, "checkout", "-q", "--ignore-other-worktrees", `bossman/${ids.mine}`);
  git(other.path, "merge", "-q", "--ff-only", "origin/main");
  writeFileSync(path.join(other.path, "plan.test.ts"), "test\n");
  git(other.path, "add", "plan.test.ts");
  git(other.path, "commit", "-qm", "Tests (BOS-1128)");
  git(other.path, "checkout", "-q", `bossman/${ids.other}`);
  return { bare, ws, spec, mine };
}

describe("a ticket's copy behind its own branch (BOS-1231)", () => {
  it("today's code would list main's files as uncommitted; the copy is brought up to its branch and the merge goes on", async () => {
    const { bare, ws, spec, mine } = await staleCopy();
    // The false list as the author was sent it: main's files and the ticket's own test, none of it uncommitted work.
    const shown = git(mine.path, "status", "--porcelain").split("\n").map((l) => l.slice(3)).sort();
    expect(shown).toEqual(["check-limit.ts", "launcher.ts", "plan.test.ts"]);

    const r = await ws.merge(spec, "main", "Merge mine");
    expect(r.status).toBe("merged");
    expect(git(bare, "show", "main:plan.test.ts")).toBe("test");
    expect(git(bare, "show", "main:launcher.ts")).toBe("launcher v2");
    // The folder now matches its branch: nothing left for anyone to commit.
    expect(git(mine.path, "status", "--porcelain")).toBe("");
    expect(git(mine.path, "rev-parse", "HEAD")).toBe(git(bare, "rev-parse", "main^2"));
  });

  it("a stale copy with the author's own new file: moved up, and only that file is theirs to commit", async () => {
    const { ws, spec, mine } = await staleCopy();
    writeFileSync(path.join(mine.path, "draft.ts"), "the author's own, never committed\n");
    expect(await ws.merge(spec, "main", "Merge mine")).toEqual({ status: "uncommitted", files: ["draft.ts"] });
    expect(git(mine.path, "status", "--porcelain")).toBe("?? draft.ts");
  });

  it("a stale copy that can't be moved up safely: the moved-on files are never offered to the author, and nothing is touched", async () => {
    const { bare, ws, spec, mine } = await staleCopy();
    // An edit to a file the branch moved on: the switch would overwrite it, so git refuses.
    writeFileSync(path.join(mine.path, "launcher.ts"), "edited in the stale copy\n");
    writeFileSync(path.join(mine.path, "draft.ts"), "the author's own\n");
    const before = { main: git(bare, "rev-parse", "main"), status: git(mine.path, "status", "--porcelain") };
    const r = await ws.merge(spec, "main", "Merge mine");
    expect(r).toEqual({ status: "uncommitted", files: ["draft.ts"], foreign: expect.any(Array) });
    expect((r as { foreign: string[] }).foreign.sort()).toEqual(["check-limit.ts", "launcher.ts", "plan.test.ts"]);
    expect(git(bare, "rev-parse", "main")).toBe(before.main);
    expect(git(mine.path, "status", "--porcelain")).toBe(before.status);
    // The same split for a pull request push, and the server-queued prepare.
    expect(await ws.pushForReview(spec, "main")).toEqual(r);
    expect(await ws.merge(spec, "main", "Merge mine", {}, null, { phase: "prepare" })).toEqual(r);
  });

  it("an unstaged change listed first keeps its whole path", async () => {
    const { ws, spec, mine } = await staleCopy();
    await ws.merge(spec, "main", "Merge mine"); // brings the copy up to date
    writeFileSync(path.join(mine.path, "app.txt"), "edited, not committed\n");
    // `git status` prints " M app.txt"; the runner's git trims that leading space, which cut the old list to "pp.txt".
    expect(await ws.merge(spec, "main", "again")).toEqual({ status: "uncommitted", files: ["app.txt"] });
  });
});
