// R46 and R47 against a real bare "origin": merge without a working tree, conflicts,
// uncommitted work, a moving target, and verify commands.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

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

  it("runs a check's installs against the shared pnpm store, not a new one in HOME (BOS-568)", async () => {
    const o = origin();
    const { spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-root-"));
    const store = path.join(root, "store");
    const ws = new Workspaces(root, process.env, undefined, store);
    await ws.ensure(spec);
    expect((await ws.verify(spec, 'echo "store=${npm_config_store_dir:-unset}"')).output).toContain(`store=${store}`);
    // A runner without one gives pnpm nothing, as before.
    const plain = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    await plain.ensure(spec);
    expect((await plain.verify(spec, 'echo "store=${npm_config_store_dir:-unset}"')).output).toContain("store=unset");
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

  it("keeps a queued check alive while its place changes, and stops one whose place stands still (BOS-370)", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const line = (p: number) => `echo 'check-all: waiting for a free check slot (place ${p} of 4, 1 run at once)'`;
    // 900 ms in the queue against a 300 ms limit: fine, because the place moves every 200 ms.
    const moving = await ws.verify(spec, `${line(4)}; sleep 0.2; ${line(3)}; sleep 0.2; ${line(2)}; sleep 0.2; ${line(1)}; sleep 0.2; echo 'check-all: slot taken, running the checks'`, 5000, 300);
    expect(moving).toMatchObject({ ok: true, timedOut: false });
    // The same place printed again and again is no progress.
    expect(await ws.verify(spec, `${line(3)}; sleep 0.2; ${line(3)}; sleep 0.2; ${line(3)}; sleep 5`, 5000, 300)).toMatchObject({ ok: false, timedOut: true });
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
    git(w.path, "merge", "--no-edit", `bossman/${ids2.other}`);
    expect(await ws.carried(spec, "main", branches)).toMatchObject({ carried: [{ ticketId: ids2.other, branch: `bossman/${ids2.other}` }] });
    // Nothing merges with the guard in place: the branch is exactly as it was.
    expect(git(w.path, "status", "--porcelain")).toBe("");
  });

  it("does not count a branch that merged this ticket in as carried (BOS-365)", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const other = await ws.ensure({ ...spec, ticketId: ids2.other });
    writeFileSync(path.join(other.path, "other.txt"), "their work\n");
    git(other.path, "add", ".");
    git(other.path, "commit", "-qm", "other ticket's work");
    // The other ticket builds on this one by merging it in; this ticket never merges the other.
    git(other.path, "merge", "--no-edit", `bossman/${ids.t}`);
    expect(await ws.carried(spec, "main", [{ ticketId: ids2.other, branch: `bossman/${ids2.other}` }])).toEqual({ carried: [] });
  });

  it("still counts a branch this ticket fast-forwarded in (BOS-365)", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const other = await ws.ensure({ ...spec, ticketId: ids2.other });
    writeFileSync(path.join(other.path, "other.txt"), "their work\n");
    git(other.path, "add", ".");
    git(other.path, "commit", "-qm", "other ticket's work");
    // A third ticket merges the other in before committing anything: a fast-forward.
    const ffId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ff = await ws.ensure({ ...spec, ticketId: ffId });
    git(ff.path, "merge", "--no-edit", `bossman/${ids2.other}`);
    writeFileSync(path.join(ff.path, "ff.txt"), "own\n");
    git(ff.path, "add", ".");
    git(ff.path, "commit", "-qm", "ff ticket's work");
    const hit = { ticketId: ids2.other, branch: `bossman/${ids2.other}` };
    expect(await ws.carried({ ...spec, ticketId: ffId }, "main", [hit])).toEqual({ carried: [{ ...hit, contained: true }] });
  });

  it("does not count a branch created from this ticket's tip, then committed (BOS-629)", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const tip = git(ws.repoDir(ids.project), "rev-parse", `bossman/${ids.t}`);
    const bId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const b = await ws.ensure({ ...spec, ticketId: bId, baseRef: tip });
    writeFileSync(path.join(b.path, "b.txt"), "own\n");
    git(b.path, "add", ".");
    git(b.path, "commit", "-qm", "stacked ticket's work");
    expect(await ws.carried(spec, "main", [{ ticketId: bId, branch: `bossman/${bId}` }])).toEqual({ carried: [] });
  });

  it("still counts a stacked branch's own commit once this ticket takes it in (BOS-629)", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const tip = git(ws.repoDir(ids.project), "rev-parse", `bossman/${ids.t}`);
    const bId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const b = await ws.ensure({ ...spec, ticketId: bId, baseRef: tip });
    writeFileSync(path.join(b.path, "b.txt"), "own\n");
    git(b.path, "add", ".");
    git(b.path, "commit", "-qm", "stacked ticket's work");
    const w = await ws.ensure(spec);
    git(w.path, "merge", "--no-edit", `bossman/${bId}`);
    const hit = { ticketId: bId, branch: `bossman/${bId}` };
    expect(await ws.carried(spec, "main", [hit])).toMatchObject({ carried: [hit] });
  });

  it("still counts a branch that fast-forwarded this ticket in, then committed: same shape as the reverse, so it can't be told apart (BOS-369)", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const ffId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ff = await ws.ensure({ ...spec, ticketId: ffId });
    git(ff.path, "merge", "--no-edit", `bossman/${ids.t}`);
    writeFileSync(path.join(ff.path, "ff.txt"), "own\n");
    git(ff.path, "add", ".");
    git(ff.path, "commit", "-qm", "ff ticket's work");
    const hit = { ticketId: ffId, branch: `bossman/${ffId}` };
    expect(await ws.carried(spec, "main", [hit])).toEqual({ carried: [{ ...hit, contained: false }] });
  });

  it("still counts a branch whose work this ticket fast-forwarded in, then committed, before the branch fast-forwarded this ticket (BOS-369)", async () => {
    const o = origin();
    const { ws } = await ticketWithCommit(o, "feature.txt", "new\n");
    const tId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const bId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const spec = { projectId: ids.project, ticketId: tId, repoUrl: o.url, baseRef: "main" };
    const b = await ws.ensure({ ...spec, ticketId: bId });
    writeFileSync(path.join(b.path, "b1.txt"), "b1\n");
    git(b.path, "add", ".");
    git(b.path, "commit", "-qm", "b1");
    const t = await ws.ensure(spec);
    git(t.path, "merge", "--no-edit", `bossman/${bId}`);
    writeFileSync(path.join(t.path, "t1.txt"), "t1\n");
    git(t.path, "add", ".");
    git(t.path, "commit", "-qm", "t1");
    git(b.path, "merge", "--no-edit", `bossman/${tId}`);
    writeFileSync(path.join(b.path, "b2.txt"), "b2\n");
    git(b.path, "add", ".");
    git(b.path, "commit", "-qm", "b2");
    const hit = { ticketId: bId, branch: `bossman/${bId}` };
    expect(await ws.carried(spec, "main", [hit])).toMatchObject({ carried: [hit] });
  });

  it("still counts a branch whose work this ticket merged in before the branch fast-forwarded this ticket (BOS-369)", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const bId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const b = await ws.ensure({ ...spec, ticketId: bId });
    writeFileSync(path.join(b.path, "b1.txt"), "b1\n");
    git(b.path, "add", ".");
    git(b.path, "commit", "-qm", "b1");
    // This ticket merges B in (holding b1); B then fast-forwards this ticket and commits b2.
    const w = await ws.ensure(spec);
    git(w.path, "merge", "--no-edit", `bossman/${bId}`);
    git(b.path, "merge", "--no-edit", `bossman/${ids.t}`);
    writeFileSync(path.join(b.path, "b2.txt"), "b2\n");
    git(b.path, "add", ".");
    git(b.path, "commit", "-qm", "b2");
    const hit = { ticketId: bId, branch: `bossman/${bId}` };
    expect(await ws.carried(spec, "main", [hit])).toMatchObject({ carried: [hit] });
  });

  it("counts a branch this ticket was fast-forwarded onto, even after the branch merged this ticket back in (BOS-340)", async () => {
    const o = origin();
    const { ws, spec, w } = await ticketWithCommit(o, "feature.txt", "new\n");
    const bId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const b = await ws.ensure({ ...spec, ticketId: bId });
    // 1. B commits its own work.
    writeFileSync(path.join(b.path, "b1.txt"), "b1\n");
    git(b.path, "add", ".");
    git(b.path, "commit", "-qm", "b1");
    // 2. This ticket (A) is reset to main, fast-forwarded onto B, then commits its own work.
    git(w.path, "reset", "-q", "--hard", "main");
    git(w.path, "merge", "--ff-only", `bossman/${bId}`);
    writeFileSync(path.join(w.path, "a2.txt"), "a2\n");
    git(w.path, "add", ".");
    git(w.path, "commit", "-qm", "a2");
    // 3. B merges A in with a merge commit.
    git(b.path, "merge", "--no-ff", "--no-edit", `bossman/${ids.t}`);
    // 4. A still holds B's commit, so B is carried.
    const hit = { ticketId: bId, branch: `bossman/${bId}` };
    expect(await ws.carried(spec, "main", [hit])).toMatchObject({ carried: [hit] });
  });

  it("finds nothing once the carried branch has itself merged to the target", async () => {
    const o = origin();
    const { ws, spec, w } = await ticketWithCommit(o, "feature.txt", "new\n");
    const other = await ws.ensure({ ...spec, ticketId: ids2.other });
    writeFileSync(path.join(other.path, "other.txt"), "their work\n");
    git(other.path, "add", ".");
    git(other.path, "commit", "-qm", "other ticket's work");
    await ws.merge({ projectId: spec.projectId, ticketId: ids2.other }, "main", "Merge the other ticket");
    git(w.path, "merge", "--no-edit", `bossman/${ids2.other}`);
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
