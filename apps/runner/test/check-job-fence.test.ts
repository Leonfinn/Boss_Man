// BOS-316 (security F1): a server-queued check job runs a commit nobody has reviewed, so it runs fenced:
// it can't read files outside its folder (the runner's token, other tickets' worktrees) and has its own HOME.
// BOS-655: the job's HOME is removed when it ends, and a runner that can't fence still gives the job its own
// HOME/TMPDIR and the pnpm store on the workspaces volume, so an install doesn't fill the root disk.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { levelFor, probeLandlock, type FenceLevel } from "../src/fence.js";
import { Workspaces } from "../src/workspace.js";

const level = levelFor(probeLandlock().abi).level;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const projectId = "11111111-1111-4111-8111-111111111111";

/** A workspaces root with a bare copy of a one-commit repo, and that commit. */
function setup(jobFence: { level: FenceLevel; pnpmStore?: string }) {
  const bare = mkdtempSync(path.join(tmpdir(), "bm-fj-origin-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(path.join(tmpdir(), "bm-fj-seed-"));
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "a.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const commit = git(seed, "rev-parse", "HEAD");
  const root = mkdtempSync(path.join(tmpdir(), "bm-fj-root-"));
  mkdirSync(path.join(root, "repos"), { recursive: true });
  git(root, "clone", "-q", "--bare", bare, path.join(root, "repos", `${projectId}.git`));
  return { root, commit, ws: new Workspaces(root, process.env, undefined, jobFence) };
}

describe.skipIf(level === "unavailable")("fenced check job", () => {
  it("can't read a secret outside its folder, gets its own HOME, and leaves no HOME behind", async () => {
    const secretDir = mkdtempSync(path.join(process.env.HOME ?? tmpdir(), ".bm-fj-secret-"));
    writeFileSync(path.join(secretDir, "token"), "TOPSECRET");
    const { root, commit, ws } = setup({ level });
    const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const r = await ws.runCommitCheck({ projectId, jobId, commit }, `cat ${secretDir}/token; echo home=$HOME`, 60_000);
    expect(r.output).not.toContain("TOPSECRET");
    expect(r.output).toContain(`home=${path.join(root, "check-jobs-home", jobId)}`);
    expect(existsSync(path.join(root, "check-jobs-home", jobId))).toBe(false);
    expect(existsSync(path.join(root, "check-jobs", jobId))).toBe(false);
  });
});

describe("unfenced check job (BOS-655)", () => {
  it("still gets its own HOME/TMPDIR and the pnpm store on the workspaces volume, and leaves no HOME behind", async () => {
    const { root, commit } = setup({ level: "unavailable" });
    const store = path.join(root, ".pnpm-store");
    const unfenced = new Workspaces(root, process.env, undefined, { level: "unavailable", pnpmStore: store });
    const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const home = path.join(root, "check-jobs-home", jobId);
    const r = await unfenced.runCommitCheck({ projectId, jobId, commit }, 'echo "home=$HOME"; echo "tmp=$TMPDIR"; echo "store=$npm_config_store_dir"; touch "$TMPDIR/x"', 60_000);
    expect(r.ok).toBe(true);
    expect(r.output).toContain(`home=${home}`);
    expect(r.output).toContain(`tmp=${path.join(home, "tmp")}`);
    expect(r.output).toContain(`store=${store}`);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(path.join(root, "check-jobs", jobId))).toBe(false);
  });
});
