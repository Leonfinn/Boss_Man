// BOS-617 / BOS-565: a server-queued check job's HOME/TMPDIR folder goes when the job ends, and folders left by a
// restart (no running job owns them) are swept at start-up.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { levelFor, probeLandlock } from "../src/fence.js";
import { Workspaces } from "../src/workspace.js";

const level = levelFor(probeLandlock().abi).level;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const projectId = "11111111-1111-4111-8111-111111111111";

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const bare = tmp("bm-cjc-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-cjc-seed-");
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "a.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const root = tmp("bm-cjc-root-");
  mkdirSync(path.join(root, "repos"), { recursive: true });
  git(root, "clone", "-q", "--bare", bare, path.join(root, "repos", `${projectId}.git`));
  return { root, commit: git(seed, "rev-parse", "HEAD") };
}

describe("check job folders", () => {
  it.skipIf(level === "unavailable")("removes the job's home folder, with what the check left in it, when the job ends", async () => {
    const { root, commit } = setup();
    const ws = new Workspaces(root, process.env, undefined, undefined, { level });
    const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const r = await ws.runCommitCheck({ projectId, jobId, commit }, 'echo junk > "$TMPDIR/left-behind"; echo ok', 60_000);
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(root, "check-jobs-home", jobId))).toBe(false);
    expect(existsSync(path.join(root, "check-jobs", jobId))).toBe(false);
  });

  it("removes check-jobs and check-jobs-home folders no running job owns, and prunes the stale worktree entry", async () => {
    const { root, commit } = setup();
    const ws = new Workspaces(root, process.env);
    const jobId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const repo = path.join(root, "repos", `${projectId}.git`);
    // A worktree and a home folder as a killed runner leaves them.
    mkdirSync(path.join(root, "check-jobs"), { recursive: true });
    git(repo, "worktree", "add", "--quiet", "--detach", path.join(root, "check-jobs", jobId), commit);
    mkdirSync(path.join(root, "check-jobs-home", jobId, "tmp"), { recursive: true });
    writeFileSync(path.join(root, "check-jobs-home", jobId, "tmp", "junk"), "x");
    mkdirSync(path.join(root, "check-jobs-home", "not-a-job"), { recursive: true });

    const report = await ws.housekeeping();
    expect(report.removed).toEqual(expect.arrayContaining([`check-jobs/${jobId}`, `check-jobs-home/${jobId}`, "check-jobs-home/not-a-job"]));
    expect(existsSync(path.join(root, "check-jobs", jobId))).toBe(false);
    expect(existsSync(path.join(root, "check-jobs-home"))).toBe(true);
    expect(existsSync(path.join(root, "check-jobs-home", jobId))).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(jobId);
  });

  it("leaves a running job's folders alone", async () => {
    const { root, commit } = setup();
    const ws = new Workspaces(root, process.env);
    const jobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const running = ws.runCommitCheck({ projectId, jobId, commit }, "sleep 3", 60_000);
    await new Promise((r) => setTimeout(r, 1000));
    expect(existsSync(path.join(root, "check-jobs", jobId))).toBe(true);
    await ws.housekeeping();
    expect(existsSync(path.join(root, "check-jobs", jobId))).toBe(true);
    expect((await running).ok).toBe(true);
  });
});
