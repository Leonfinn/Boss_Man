// BOS-316 (security F1): a server-queued check job runs a commit nobody has reviewed, so it runs fenced:
// it can't read files outside its folder (the runner's token, other tickets' worktrees) and has its own HOME.
// BOS-655: the job's HOME is removed when it ends, and a runner that can't fence still gives the job its own
// HOME/TMPDIR and the pnpm store on the workspaces volume, so an install doesn't fill the root disk.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { levelFor, probeLandlock, shortTmpName, SOCKET_SUFFIX_ROOM, SUN_PATH_MAX, type FenceLevel } from "../src/fence.js";
import { Workspaces } from "../src/workspace.js";

const level = levelFor(probeLandlock().abi).level;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const projectId = "11111111-1111-4111-8111-111111111111";

const dirs: string[] = [];
const tmp = (prefix: string, base = tmpdir()) => {
  const d = mkdtempSync(path.join(base, prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workspaces root with a bare copy of a one-commit repo, and that commit. */
function setup(jobFence: { level: FenceLevel; pnpmStore?: string }, prefix = "bm-fj") {
  const bare = tmp(`${prefix}-origin-`);
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp(`${prefix}-seed-`);
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "a.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const commit = git(seed, "rev-parse", "HEAD");
  const root = tmp(`${prefix}-root-`);
  mkdirSync(path.join(root, "repos"), { recursive: true });
  git(root, "clone", "-q", "--bare", bare, path.join(root, "repos", `${projectId}.git`));
  return { root, commit, ws: new Workspaces(root, process.env, undefined, undefined, jobFence) };
}

describe.skipIf(level === "unavailable")("fenced check job", () => {
  it("can't read a secret outside its folder, gets its own HOME, and leaves no HOME behind", async () => {
    // The secret must sit outside the job's folder. HOME is the usual place, but a check job whose runner is still
    // the old code has a HOME that doesn't exist yet: create it, and fall back to the temp folder if that fails.
    let secretBase = process.env.HOME ?? tmpdir();
    try {
      mkdirSync(secretBase, { recursive: true });
    } catch {
      secretBase = tmpdir();
    }
    const secretDir = tmp(".bm-fj-secret-", secretBase);
    writeFileSync(path.join(secretDir, "token"), "TOPSECRET");
    const { root, commit, ws } = setup({ level });
    const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const r = await ws.runCommitCheck({ projectId, jobId, commit }, `cat ${secretDir}/token; echo home=$HOME; test -d "$HOME" && echo homeexists=yes; touch "$HOME/probe" && echo homewritable=yes`, 60_000);
    // BOS-1095: HOME must exist when the job starts (the gate bounced branches with "HOME folder missing").
    expect(r.output).toContain("homeexists=yes");
    expect(r.output).toContain("homewritable=yes");
    expect(r.output).not.toContain("TOPSECRET");
    expect(r.output).toContain(`home=${path.join(root, "check-jobs-home", jobId)}`);
    expect(existsSync(path.join(root, "check-jobs-home", jobId))).toBe(false);
    expect(existsSync(path.join(root, "check-jobs", jobId))).toBe(false);
  });
});

describe("check job finds the global browser tools (BOS-1095)", () => {
  it("gets NODE_PATH and PLAYWRIGHT_BROWSERS_PATH, and can read the folders they name", async () => {
    // The real-browser web tests need `require("playwright")` (a global npm tool, found through NODE_PATH). Without
    // it they skipped inside the gate and BOS-1071 failed every merge on the skips.
    const globalModules = tmp("bm-fj-global-");
    mkdirSync(path.join(globalModules, "playwright"));
    writeFileSync(path.join(globalModules, "playwright", "index.js"), "module.exports = { chromium: 'found' };\n");
    const browsers = tmp("bm-fj-browsers-");
    writeFileSync(path.join(browsers, "marker"), "browsers-here");
    const { commit, root } = setup({ level });
    const ws = new Workspaces(root, { ...process.env, NODE_PATH: globalModules, PLAYWRIGHT_BROWSERS_PATH: browsers }, undefined, undefined, { level });
    const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const r = await ws.runCommitCheck({ projectId, jobId, commit }, `node -e 'console.log("pw=" + require("playwright").chromium)'; echo browsers=$PLAYWRIGHT_BROWSERS_PATH; cat "$PLAYWRIGHT_BROWSERS_PATH/marker"`, 60_000);
    expect(r.output).toContain("pw=found");
    expect(r.output).toContain(`browsers=${browsers}`);
    expect(r.output).toContain("browsers-here");
  });
});

describe("unfenced check job (BOS-655)", () => {
  it("still gets its own HOME/TMPDIR and the pnpm store on the workspaces volume, and leaves no HOME behind", async () => {
    const { root, commit } = setup({ level: "unavailable" });
    const store = path.join(root, ".pnpm-store");
    const gate = `${store}-gate`;
    const unfenced = new Workspaces(root, process.env, undefined, gate, { level: "unavailable", pnpmStore: store });
    const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const home = path.join(root, "check-jobs-home", jobId);
    const r = await unfenced.runCommitCheck({ projectId, jobId, commit }, 'echo "home=$HOME"; test -d "$HOME" && echo homeexists=yes; echo "tmp=$TMPDIR"; echo "store=$npm_config_store_dir"; touch "$TMPDIR/x"', 60_000);
    expect(r.ok).toBe(true);
    expect(r.output).toContain(`home=${home}`);
    expect(r.output).toContain("homeexists=yes");
    expect(r.output).toContain(`tmp=${path.join(root, "jt", shortTmpName(jobId))}`);
    expect(existsSync(path.join(root, "jt", shortTmpName(jobId)))).toBe(false);
    // BOS-1087: a socket under the job's TMPDIR must fit in sun_path (107 bytes). The test root is longer than a real
    // runner's, so measure the part under the root and put it on the real workspaces root (/home/node/workspaces).
    const tmpPrinted = /tmp=(.*)/.exec(r.output)![1]!;
    const onRealRoot = path.join("/home/node/workspaces", path.relative(root, tmpPrinted));
    expect(Buffer.byteLength(onRealRoot) + SOCKET_SUFFIX_ROOM).toBeLessThanOrEqual(SUN_PATH_MAX);
    expect(Buffer.byteLength(onRealRoot)).toBeLessThanOrEqual(40);
    expect(r.output).toContain(`store=${store}`);
    expect(r.output).not.toContain(gate);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(path.join(root, "check-jobs", jobId))).toBe(false);
  });
});

// BOS-568 review: a job must never install from the merge gate's store (the gate runs unfenced as the runner).
// A fenced job, and one on a runner that can't fence, both use the agents' shared store instead.
describe("a job's pnpm store (BOS-568 review)", () => {
  function setup() {
    const bare = tmp("bm-fjs-origin-");
    git(bare, "init", "-q", "--bare", "-b", "main");
    const seed = tmp("bm-fjs-seed-");
    git(seed, "clone", "-q", bare, ".");
    writeFileSync(path.join(seed, "a.txt"), "a\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const commit = git(seed, "rev-parse", "HEAD");
    const root = tmp("bm-fjs-root-");
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
    // "unavailable": jobFenceFor gives the job its env (HOME, TMPDIR, store) but no fence wrapper (BOS-655).
    const ws = new Workspaces(root, process.env, undefined, gate, { level: "unavailable", pnpmStore: shared });
    const r = await ws.runCommitCheck({ projectId, jobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", commit }, `echo "store=$npm_config_store_dir"`, 60_000);
    expect(r.output).toContain(`store=${shared}`);
    expect(r.output).not.toContain(gate);
  });
});

// BOS-1039: npm puts agent binaries behind links (bin/opencode -> ../lib/node_modules/opencode-ai/bin/opencode.exe). The
// fence grants the PATH folders, but Landlock checks the real file, so a fenced job couldn't run the agent it was meant to.
describe.skipIf(level === "unavailable")("fenced check job runs an agent binary behind a PATH link (BOS-1039)", () => {
  it("runs opencode when PATH holds only a link to it", async () => {
    const prefix = tmp("bm-fj-npm-");
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    mkdirSync(path.join(prefix, "lib", "pkg", "bin"), { recursive: true });
    const real = path.join(prefix, "lib", "pkg", "bin", "opencode.exe");
    writeFileSync(real, "#!/bin/sh\necho agent-ran\n", { mode: 0o755 });
    symlinkSync(real, path.join(prefix, "bin", "opencode"));
    const { root, commit } = setup({ level }, "bm-fj-link");
    const ws = new Workspaces(root, { ...process.env, PATH: `${path.join(prefix, "bin")}:${process.env.PATH}` }, undefined, undefined, { level });
    const r = await ws.runCommitCheck({ projectId, jobId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", commit }, "opencode", 60_000);
    expect(r.output).toContain("agent-ran");
  });
});
