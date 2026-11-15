// BOS-1411: the read-only merge-line probe. `mergeLineConflicts` runs `git merge-tree` of this ticket's branch against
// each other approved branch, on a real bare origin and worktree copies: two branches editing the same lines are a
// real conflict, two touching different parts of one file are not, and a branch already inside this one is skipped.
// Nothing is built, pushed or merged.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A bare origin with one file of ten lines, seeded from `seed`, and a workspace with a copy per ticket. */
async function origin(files: Record<string, string>) {
  const bare = tmp("bm-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-seed-");
  git(seed, "clone", "-q", bare, ".");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.join(seed, path.dirname(name)), { recursive: true });
    writeFileSync(path.join(seed, name), content);
  }
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const ws = new Workspaces(tmp("bm-ws-root-"), { ...process.env, BOSSMAN_TICKET_COPIES: "worktree" });
  const ensure = (ticketId: string) => ws.ensure({ projectId: project, ticketId, repoUrl: bare, baseRef: "main" });
  const commit = async (ticketId: string, file: string, content: string) => {
    const w = await ensure(ticketId);
    writeFileSync(path.join(w.path, file), content);
    git(w.path, "add", ".");
    git(w.path, "commit", "-qm", `work on ${file}`);
  };
  return { ws, bare, ensure, commit, mainSha: () => git(bare, "rev-parse", "main") };
}

const TEN = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";

describe("merge-line conflicts on the runner (BOS-1411)", () => {
  it("two branches editing the same lines: a real conflict in that file", async () => {
    const o = await origin({ "src/app.ts": TEN });
    await o.commit(A, "src/app.ts", "1\n2\n3\n4\nFIVE-BY-A\n6\n7\n8\n9\n10\n");
    const mine = await o.ensure(B);
    writeFileSync(path.join(mine.path, "src/app.ts"), "1\n2\n3\n4\nFIVE-BY-B\n6\n7\n8\n9\n10\n");
    git(mine.path, "add", ".");
    git(mine.path, "commit", "-qm", "work on src/app.ts");
    const before = o.mainSha();
    const r = await o.ws.mergeLineConflicts({ projectId: project, ticketId: B }, "main", [{ ticketId: A, branch: `bossman/${A}` }]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ ticketId: A, clashes: true });
    expect(r.conflicts[0]!.files).toContain("src/app.ts");
    // Read-only: main did not move and nothing was built or pushed.
    expect(o.mainSha()).toBe(before);
  });

  it("two branches touching different parts of the same file: no warning", async () => {
    const o = await origin({ "src/app.ts": TEN });
    await o.commit(A, "src/app.ts", "CHANGED-AT-TOP\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    const mine = await o.ensure(B);
    writeFileSync(path.join(mine.path, "src/app.ts"), "1\n2\n3\n4\n5\n6\n7\n8\n9\nCHANGED-AT-BOTTOM\n");
    git(mine.path, "add", ".");
    git(mine.path, "commit", "-qm", "work on src/app.ts");
    const r = await o.ws.mergeLineConflicts({ projectId: project, ticketId: B }, "main", [{ ticketId: A, branch: `bossman/${A}` }]);
    expect(r.conflicts).toHaveLength(0);
  });

  it("skips a branch already inside this one, and reports only the ones that really clash", async () => {
    const o = await origin({ "src/app.ts": TEN, "src/other.ts": "x\n" });
    // C makes a clean, separate change; A edits the same line as B.
    await o.commit(C, "src/other.ts", "y\n");
    await o.commit(A, "src/app.ts", "1\n2\n3\n4\nFIVE-BY-A\n6\n7\n8\n9\n10\n");
    const mine = await o.ensure(B);
    // B carries C's whole branch (as a stack would): merging C says nothing, so C is skipped.
    git(mine.path, "merge", "-q", "--no-edit", `bossman/${C}`);
    writeFileSync(path.join(mine.path, "src/app.ts"), "1\n2\n3\n4\nFIVE-BY-B\n6\n7\n8\n9\n10\n");
    git(mine.path, "add", ".");
    git(mine.path, "commit", "-qm", "work on src/app.ts");
    const r = await o.ws.mergeLineConflicts({ projectId: project, ticketId: B }, "main", [
      { ticketId: C, branch: `bossman/${C}` },
      { ticketId: A, branch: `bossman/${A}` },
    ]);
    expect(r.conflicts.map((c) => c.ticketId)).toEqual([A]);
  });

  it("a branch that can't be read here is left out rather than called clean or a clash", async () => {
    const o = await origin({ "src/app.ts": TEN });
    const mine = await o.ensure(B);
    writeFileSync(path.join(mine.path, "src/app.ts"), "1\n2\n3\n4\nFIVE-BY-B\n6\n7\n8\n9\n10\n");
    git(mine.path, "add", ".");
    git(mine.path, "commit", "-qm", "work on src/app.ts");
    const ghost = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const r = await o.ws.mergeLineConflicts({ projectId: project, ticketId: B }, "main", [{ ticketId: ghost, branch: `bossman/${ghost}` }]);
    expect(r.conflicts).toHaveLength(0);
  });
});
