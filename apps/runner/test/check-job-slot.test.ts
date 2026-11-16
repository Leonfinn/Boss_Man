// BOS-805: a server-queued check job takes a runner check slot from the shared coord dir, like a hand-run check, waits for
// one when none is free (printing the queue line the progress reads), and gives it back on every exit path, a cancel included.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const projectId = "11111111-1111-4111-8111-111111111111";
const SLOT_SCRIPT = path.resolve(__dirname, "../../../scripts/check-slot.sh");
const hasFlock = spawnSync("flock", ["--version"]).status === 0;

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
  const bare = tmp("bm-cjs-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-cjs-seed-");
  git(seed, "clone", "-q", bare, ".");
  mkdirSync(path.join(seed, "scripts"));
  writeFileSync(path.join(seed, "scripts", "check-all.sh"), "#!/bin/sh\nexit 0\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const root = tmp("bm-cjs-root-");
  mkdirSync(path.join(root, "repos"), { recursive: true });
  git(root, "clone", "-q", "--bare", bare, path.join(root, "repos", `${projectId}.git`));
  const coord = tmp("bm-cjs-coord-");
  const slot = path.join(tmp("bm-cjs-slot-"), "check-slot.sh");
  copyFileSync(SLOT_SCRIPT, slot);
  chmodSync(slot, 0o755);
  const env = { ...process.env, BOSSMAN_CHECK_SLOT: slot, CHECK_ALL_REPORT: "1", CHECK_ALL_QUEUE_REPORT: "1" };
  return { root, coord, env, commit: git(seed, "rev-parse", "HEAD") };
}

const slotFree = (coord: string) => spawnSync("flock", ["-n", path.join(coord, "queue", "check-all.slot.1"), "true"]).status === 0;
const until = async (f: () => boolean, ms = 15_000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 100));
  return f();
};

describe.skipIf(!hasFlock)("check job runner slot", () => {
  it("holds a slot while it runs and gives it back when it ends", async () => {
    const { root, coord, env, commit } = setup();
    mkdirSync(path.join(coord, "queue"), { recursive: true });
    const ws = new Workspaces(root, env, coord);
    const r = await ws.runCommitCheck({ projectId, jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", commit }, `[ -d "$(dirname "$CHECK_ALL_LOCK")" ] && echo held-ok; sleep 1`, 60_000, {
      onStart: () => {},
    });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("check-all: slot taken, running the checks");
    expect(await until(() => slotFree(coord))).toBe(true);
  });

  it("waits while another check holds the only slot, then runs", async () => {
    const { root, coord, env, commit } = setup();
    mkdirSync(path.join(coord, "queue"), { recursive: true });
    // A hand-run check holding slot 1 (same lock the job uses).
    const hold = spawn("flock", [path.join(coord, "queue", "check-all.slot.1"), "sleep", "4"], { stdio: "ignore" });
    // Wait for the lock to really be held (not a fixed sleep: a slow machine started flock late and the job took the slot first).
    expect(await until(() => !slotFree(coord))).toBe(true);
    const ws = new Workspaces(root, env, coord);
    let seen = "";
    const started = Date.now();
    const r = await ws.runCommitCheck({ projectId, jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", commit }, "echo ran", 60_000, { onOutput: (t) => (seen = t) });
    expect(Date.now() - started).toBeGreaterThan(2000);
    expect(seen).toContain("waiting for a free check slot");
    expect(r.ok).toBe(true);
    hold.kill();
  });

  it("frees the slot when the job is cancelled, and when it fails", async () => {
    const { root, coord, env, commit } = setup();
    mkdirSync(path.join(coord, "queue"), { recursive: true });
    const ws = new Workspaces(root, env, coord);
    let cancel: () => void = () => {};
    const running = ws.runCommitCheck({ projectId, jobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", commit }, "sleep 300", 600_000, { onStart: (c) => (cancel = c) });
    expect(await until(() => !slotFree(coord))).toBe(true);
    cancel();
    await running;
    expect(await until(() => slotFree(coord))).toBe(true);
    const failed = await ws.runCommitCheck({ projectId, jobId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", commit }, "exit 3", 60_000);
    expect(failed.exitCode).toBe(3);
    // The slot's lock is dropped when the holder process exits, a moment after the job's own result: wait for it, with a deadline.
    expect(await until(() => slotFree(coord))).toBe(true);
    expect(existsSync(path.join(coord, "queue"))).toBe(true);
  });

  // BOS-1228: a failed job keeps the start and end of its whole log (middle cut, secrets removed); a pass keeps none.
  it("keeps a cut, redacted full log for a failed job and none for a passing one", async () => {
    const { root, coord, env, commit } = setup();
    mkdirSync(path.join(coord, "queue"), { recursive: true });
    const ws = new Workspaces(root, env, coord);
    // Fake secret, made up for this test.
    const noisy = `echo START-LINE; echo MY_API_KEY=hunter2fakevalue; yes 'ordinary noise line' | head -c 3000000; echo END-LINE; exit 1`;
    const bad = await ws.runCommitCheck({ projectId, jobId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", commit }, noisy, 120_000, {});
    expect(bad.ok).toBe(false);
    expect(bad.output.length).toBeLessThanOrEqual(8192);
    expect(bad.fullLog!.length).toBeLessThan(1_600_000);
    expect(bad.fullLog!.length).toBeGreaterThan(1_000_000);
    expect(bad.fullLog).toContain("START-LINE");
    expect(bad.fullLog!.trimEnd().endsWith("END-LINE")).toBe(true);
    expect(bad.fullLog).toMatch(/characters cut from the middle/);
    expect(bad.fullLog).not.toContain("hunter2fakevalue");
    const good = await ws.runCommitCheck({ projectId, jobId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", commit }, "echo fine", 60_000, {});
    expect(good.ok).toBe(true);
    expect(good.fullLog).toBeUndefined();
  });
});
