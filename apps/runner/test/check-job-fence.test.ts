// BOS-316 (security F1): a server-queued check job runs a commit nobody has reviewed, so it runs fenced:
// it can't read files outside its folder (the runner's token, other tickets' worktrees) and has its own HOME.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { levelFor, probeLandlock } from "../src/fence.js";
import { Workspaces } from "../src/workspace.js";

const level = levelFor(probeLandlock().abi).level;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

describe.skipIf(level === "unavailable")("fenced check job", () => {
  it("can't read a secret outside its folder, and gets its own HOME", async () => {
    const bare = mkdtempSync(path.join(tmpdir(), "bm-fj-origin-"));
    git(bare, "init", "-q", "--bare", "-b", "main");
    const seed = mkdtempSync(path.join(tmpdir(), "bm-fj-seed-"));
    git(seed, "clone", "-q", bare, ".");
    writeFileSync(path.join(seed, "a.txt"), "a\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const commit = git(seed, "rev-parse", "HEAD");
    const secretDir = mkdtempSync(path.join(process.env.HOME ?? tmpdir(), ".bm-fj-secret-"));
    writeFileSync(path.join(secretDir, "token"), "TOPSECRET");
    const root = mkdtempSync(path.join(tmpdir(), "bm-fj-root-"));
    const ws = new Workspaces(root, process.env, undefined, undefined, { level });
    const projectId = "11111111-1111-4111-8111-111111111111";
    mkdirSync(path.join(root, "repos"), { recursive: true });
    git(root, "clone", "-q", "--bare", bare, path.join(root, "repos", `${projectId}.git`));
    const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const r = await ws.runCommitCheck({ projectId, jobId, commit }, `cat ${secretDir}/token; echo home=$HOME`, 60_000);
    expect(r.output).not.toContain("TOPSECRET");
    expect(r.output).toContain(`home=${path.join(root, "check-jobs-home", jobId)}`);
  });
});

// BOS-568 review: a job must never install from the merge gate's store (the gate runs unfenced as the runner).
// A fenced job, and one on a runner that can't fence, both use the agents' shared store instead.
describe("a job's pnpm store (BOS-568 review)", () => {
  function setup() {
    const bare = mkdtempSync(path.join(tmpdir(), "bm-fjs-origin-"));
    git(bare, "init", "-q", "--bare", "-b", "main");
    const seed = mkdtempSync(path.join(tmpdir(), "bm-fjs-seed-"));
    git(seed, "clone", "-q", bare, ".");
    writeFileSync(path.join(seed, "a.txt"), "a\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const commit = git(seed, "rev-parse", "HEAD");
    const root = mkdtempSync(path.join(tmpdir(), "bm-fjs-root-"));
    const projectId = "11111111-1111-4111-8111-111111111111";
    mkdirSync(path.join(root, "repos"), { recursive: true });
    git(root, "clone", "-q", "--bare", bare, path.join(root, "repos", `${projectId}.git`));
    const shared = path.join(root, ".pnpm-store");
    const gate = `${shared}-gate`;
    return { root, projectId, commit, shared, gate };
  }

  it("a fenced job uses the shared store, never the gate's", async () => {
    const { root, projectId, commit, shared, gate } = setup();
    const ws = new Workspaces(root, process.env, undefined, gate, { level, pnpmStore: shared });
    const r = await ws.runCommitCheck({ projectId, jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", commit }, `echo "store=$npm_config_store_dir"`, 60_000);
    expect(r.output).toContain(`store=${shared}`);
    expect(r.output).not.toContain(gate);
  });

  it("a job on a runner that can't fence still uses the shared store, not a fresh one in HOME", async () => {
    const { root, projectId, commit, shared, gate } = setup();
    // "unavailable" makes jobFenceFor return nothing, so the job runs unfenced as before.
    const ws = new Workspaces(root, process.env, undefined, gate, { level: "unavailable", pnpmStore: shared });
    const r = await ws.runCommitCheck({ projectId, jobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", commit }, `echo "store=$npm_config_store_dir"`, 60_000);
    expect(r.output).toContain(`store=${shared}`);
    expect(r.output).not.toContain(gate);
  });
});
