// R46 and R47 against a real bare "origin": merge without a working tree, conflicts,
// uncommitted work, a moving target, and verify commands.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isClone, Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

/** A bare origin plus a scratch clone for pushing "other people's" commits to it. */
function origin() {
  const bare = mkdtempSync(path.join(tmpdir(), "bm-origin-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(path.join(tmpdir(), "bm-seed-"));
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "app.txt"), "line 1\nline 2\nline 3\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const pushChange = (file: string, content: string) => {
    git(seed, "pull", "-q", "origin", "main");
    writeFileSync(path.join(seed, file), content);
    git(seed, "add", ".");
    git(seed, "commit", "-qm", `edit ${file}`);
    git(seed, "push", "-q", "origin", "HEAD:main");
  };
  return { url: bare, pushChange, mainSha: () => git(bare, "rev-parse", "main") };
}

const ids = { project: "11111111-1111-4111-8111-111111111111", t: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

async function ticketWithCommit(o: ReturnType<typeof origin>, file: string, content: string) {
  const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
  const spec = { projectId: ids.project, ticketId: ids.t, repoUrl: o.url, baseRef: "main" };
  const w = await ws.ensure(spec);
  writeFileSync(path.join(w.path, file), content);
  git(w.path, "add", ".");
  git(w.path, "commit", "-qm", "ticket work");
  return { ws, spec, w };
}

describe("merging a ticket's branch (R46)", () => {
  it("merges cleanly into the named target with a merge commit, then reports already merged", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    o.pushChange("other.txt", "someone else\n"); // the target moved since the ticket started
    const r = await ws.merge(spec, "main", "Merge ticket: add feature");
    expect(r.status).toBe("merged");
    expect(o.mainSha()).toBe((r as { commit: string }).commit);
    expect(git(o.url, "log", "-1", "--format=%P", "main").split(" ")).toHaveLength(2);
    expect(git(o.url, "log", "-1", "--format=%s", "main")).toBe("Merge ticket: add feature");
    expect(git(o.url, "show", "main:feature.txt")).toBe("new");
    expect(git(o.url, "show", "main:other.txt")).toBe("someone else");
    expect((await ws.merge(spec, "main", "again")).status).toBe("already_merged");
  });

  it("reports conflicting files without changing the target", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "app.txt", "line 1\nticket's line 2\nline 3\n");
    o.pushChange("app.txt", "line 1\nmain's line 2\nline 3\n");
    const before = o.mainSha();
    expect(await ws.merge(spec, "main", "Merge")).toEqual({ status: "conflicts", files: ["app.txt"] });
    expect(o.mainSha()).toBe(before);
  });

  it("refuses while the worktree has uncommitted work, and never cleans it", async () => {
    const o = origin();
    const { ws, spec, w } = await ticketWithCommit(o, "feature.txt", "new\n");
    writeFileSync(path.join(w.path, "draft.txt"), "not committed\n");
    expect(await ws.merge(spec, "main", "Merge")).toEqual({ status: "uncommitted", files: ["draft.txt"] });
    expect(git(w.path, "status", "--porcelain")).toBe("?? draft.txt");
  });
});

describe("pushing a ticket's branch for a pull request (R59)", () => {
  it("pushes the branch without touching the target, and refuses conflicts and uncommitted work", async () => {
    const o = origin();
    const { ws, spec, w } = await ticketWithCommit(o, "feature.txt", "new\n");
    const before = o.mainSha();
    const r = await ws.pushForReview(spec, "main");
    expect(r).toEqual({ status: "pushed", branch: `bossman/${ids.t}`, commit: git(w.path, "rev-parse", "HEAD") });
    expect(git(o.url, "rev-parse", `bossman/${ids.t}`)).toBe(git(w.path, "rev-parse", "HEAD"));
    expect(o.mainSha()).toBe(before);

    writeFileSync(path.join(w.path, "draft.txt"), "not committed\n");
    expect(await ws.pushForReview(spec, "main")).toEqual({ status: "uncommitted", files: ["draft.txt"] });
  });

  it("reports conflicts with the target instead of pushing", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "app.txt", "line 1\nticket's line 2\nline 3\n");
    o.pushChange("app.txt", "line 1\nmain's line 2\nline 3\n");
    expect(await ws.pushForReview(spec, "main")).toEqual({ status: "conflicts", files: ["app.txt"] });
    expect(() => git(o.url, "rev-parse", "--verify", "--quiet", `refs/heads/bossman/${ids.t}`)).toThrow();
  });
});

describe("proposing merge checks (R57)", () => {
  it("reads the default branch's files from the clone, without a worktree, and reports the runner's tools", async () => {
    const o = origin();
    const seed = mkdtempSync(path.join(tmpdir(), "bm-detect-"));
    git(seed, "clone", "-q", o.url, ".");
    writeFileSync(path.join(seed, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest run" } }));
    writeFileSync(path.join(seed, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "node project");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const r = await ws.detect({ projectId: ids.project, repoUrl: o.url, baseRef: "main" });
    expect(r.checks.map((c) => c.command)).toEqual(["pnpm install --frozen-lockfile && pnpm typecheck && pnpm test"]);
    expect(r.tools.node).toBe(true);
    expect(typeof r.tools.cargo).toBe("boolean");
  });
});

describe("verify before done (R47)", () => {
  it("passes or fails on the command's exit code, with the tail of its output", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const ok = await ws.verify(spec, "test -f feature.txt && echo checks passed");
    expect(ok).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(ok.output).toContain("checks passed");
    const bad = await ws.verify(spec, "echo 2 tests failed >&2; exit 3");
    expect(bad).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
    expect(bad.output).toContain("2 tests failed");
    expect(await ws.verify(spec, "sleep 5", 200)).toMatchObject({ ok: false, timedOut: true });
  });

  it("shares check-all's queue folder with the agents' checks, when the runner has one (BOS-321)", async () => {
    const o = origin();
    const { spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const plain = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    await plain.ensure(spec);
    expect((await plain.verify(spec, 'echo "lock=${CHECK_ALL_LOCK:-unset}"')).output).toContain("lock=unset");
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-root-"));
    const ws = new Workspaces(root, process.env, path.join(root, ".bossman-coord"));
    await ws.ensure(spec);
    const res = await ws.verify(spec, 'echo "lock=$CHECK_ALL_LOCK store=$BOSSMAN_CHECK_STORE"');
    expect(res.output).toContain(`lock=${path.join(root, ".bossman-coord", "queue", "check-all")} store=${path.join(root, ".bossman-coord", "gate", "check-results")}`);
  });

  it("counts the timeout from when a queued check starts, not from when it was queued", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    // Queued for 600 ms (timeout 400 ms) then running 100 ms: passes. The queue has its own, longer limit.
    const waited = await ws.verify(spec, "echo 'check-all: waiting for a free check slot (place 2 of 2)'; sleep 0.6; echo 'check-all: slot taken, running the checks'; sleep 0.1", 400, 5000);
    expect(waited).toMatchObject({ ok: true, timedOut: false });
    expect(await ws.verify(spec, "echo 'check-all: waiting for a free check slot (place 2 of 2)'; sleep 5", 400, 300)).toMatchObject({ ok: false, timedOut: true });
    // Once running, the normal timeout applies.
    expect(await ws.verify(spec, "echo 'check-all: waiting for a free check slot'; echo 'check-all: slot taken, running the checks'; sleep 5", 300, 5000)).toMatchObject({ ok: false, timedOut: true });
  });

  it("kills the whole process group on timeout, including grandchildren that ignore SIGTERM", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const res = await ws.verify(spec, `(trap '' TERM; sleep 60) & echo pid=$!; wait`, 500);
    expect(res).toMatchObject({ ok: false, timedOut: true });
    const pid = Number(/pid=(\d+)/.exec(res.output)?.[1]);
    expect(pid).toBeGreaterThan(1);
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("puts a released ticket's worktree back from its branch, with the work saved at release", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    writeFileSync(path.join(ws.ticketDir(spec.ticketId), "notes.txt"), "uncommitted\n");
    await ws.release(spec);
    expect((await ws.diff(spec)).files.map((f) => f.path).sort()).toEqual(["feature.txt", "notes.txt"]);
    expect(await ws.verify(spec, "test -f feature.txt && test -f notes.txt")).toMatchObject({ ok: true });
    // No branch at all: nothing to check.
    await expect(ws.verify({ ...spec, ticketId: "00000000-0000-4000-8000-000000000000" }, "true")).rejects.toThrow("no workspace or branch");
  });
});

describe("the commits a branch carries from other open tickets (BOS-130)", () => {
  /** Another ticket's branch, made and committed on the same runner, then pushed aside. */
  const otherTicket = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ids2 = { other: otherTicket };
  /**
   * What a developer merges to take in another ticket's branch: a worktree sees it directly; a
   * clone (BOS-323) fetches it from the shared repo once a turn's end has brought it there.
   */
  const otherBranch = async (ws: Workspaces, dir: string) => {
    if (!isClone(dir)) return `bossman/${ids2.other}`;
    await ws.checkpoint({ projectId: ids.project, ticketId: ids2.other }, "after a turn");
    git(dir, "fetch", "-q", "shared");
    return `shared/bossman/${ids2.other}`;
  };

  it("says which other branches' unmerged commits this branch has, and only those", async () => {
    const o = origin();
    const { ws, spec, w } = await ticketWithCommit(o, "feature.txt", "new\n");
    // A second ticket's branch on the same workspace, with a commit main doesn't have.
    const other = await ws.ensure({ ...spec, ticketId: ids2.other });
    writeFileSync(path.join(other.path, "other.txt"), "their work\n");
    git(other.path, "add", ".");
    git(other.path, "commit", "-qm", "other ticket's work");
    // A third ticket's branch, never touched by this one.
    const third = await ws.ensure({ ...spec, ticketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    writeFileSync(path.join(third.path, "third.txt"), "unrelated\n");
    git(third.path, "add", ".");
    git(third.path, "commit", "-qm", "third ticket's work");

    const branches = [
      { ticketId: ids2.other, branch: `bossman/${ids2.other}` },
      { ticketId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", branch: "bossman/cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { ticketId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", branch: "bossman/dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    ];
    // This ticket's own branch is never reported; a branch on neither side is skipped.
    expect(await ws.carried(spec, "main", branches)).toEqual({ carried: [] });
    expect(git(path.join((ws as { root: string }).root, "repos", `${ids.project}.git`), "show", `refs/heads/bossman/${ids.t}:feature.txt`)).toBe("new");

    // This ticket merges the other in, as a developer would to stay up to date.
    git(w.path, "merge", "--no-edit", await otherBranch(ws, w.path));
    expect(await ws.carried(spec, "main", branches)).toEqual({ carried: [{ ticketId: ids2.other, branch: `bossman/${ids2.other}` }] });
    // Nothing merges with the guard in place: the branch is exactly as it was.
    expect(git(w.path, "status", "--porcelain")).toBe("");
  });

  it("finds nothing once the carried branch has itself merged to the target", async () => {
    const o = origin();
    const { ws, spec, w } = await ticketWithCommit(o, "feature.txt", "new\n");
    const other = await ws.ensure({ ...spec, ticketId: ids2.other });
    writeFileSync(path.join(other.path, "other.txt"), "their work\n");
    git(other.path, "add", ".");
    git(other.path, "commit", "-qm", "other ticket's work");
    await ws.merge({ projectId: spec.projectId, ticketId: ids2.other }, "main", "Merge the other ticket");
    git(w.path, "merge", "--no-edit", await otherBranch(ws, w.path));
    expect(await ws.carried(spec, "main", [{ ticketId: ids2.other, branch: `bossman/${ids2.other}` }])).toEqual({ carried: [] });
  });
});

describe("a ticket with no branch on this runner (BOS-130)", () => {
  it("has nothing to compare, so nothing is reported as carried", async () => {
    const o = origin();
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    await ws.ensure({ projectId: ids.project, ticketId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", repoUrl: o.url, baseRef: "main" });
    expect(await ws.carried({ projectId: ids.project, ticketId: ids.t }, "main", [{ ticketId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", branch: "bossman/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }])).toEqual({ carried: [] });
  });

  it("says so when git can't answer, rather than reporting the branch clean", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const w = await ws.ensure({ ...spec, ticketId: other });
    writeFileSync(path.join(w.path, "other.txt"), "their work\n");
    git(w.path, "add", ".");
    git(w.path, "commit", "-qm", "other ticket's work");
    // No such target on origin: rev-list can't run, so the gate mustn't look clean.
    await expect(ws.carried(spec, "no-such-target", [{ ticketId: other, branch: `bossman/${other}` }])).rejects.toThrow(/rev-list/);
  });
});
