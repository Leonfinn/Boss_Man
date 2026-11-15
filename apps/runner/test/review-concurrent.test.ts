// BOS-1476: several reviewers of one ticket start together and each prepares the same review copy.
// Needs Landlock (the fenced git), like clone-fence.test.ts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { levelFor, probeLandlock } from "../src/fence.js";
import { Workspaces } from "../src/workspace.js";

const live = levelFor(probeLandlock().abi).level !== "unavailable";
vi.stubEnv("BOSSMAN_TICKET_COPIES", "clone");
afterAll(() => vi.unstubAllEnvs());

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const ids = { project: "11111111-1111-4111-8111-111111111111", a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

async function setup() {
  const url = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
  git(url, "init", "-q", "-b", "main");
  writeFileSync(path.join(url, "README.md"), "v1\n");
  git(url, "add", ".");
  git(url, "commit", "-q", "-m", "v1");
  const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
  ws.fenceCloneGit = true;
  const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: url, baseRef: "main", review: true };
  const a = await ws.ensure(spec);
  writeFileSync(path.join(a.path, "work.txt"), "work\n");
  return { ws, spec };
}

describe.skipIf(!live)("four reviewers prepare one review copy at once (BOS-1476)", () => {
  it("every one gets the copy", async () => {
    const { ws, spec } = await setup();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => ws.ensureReview(spec)));
    expect(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))).toEqual(["ok", "ok", "ok", "ok"]);
  }, 120_000);

  it("the author committing in its own folder doesn't trouble reviews being prepared", async () => {
    const { ws, spec } = await setup();
    const dev = ws.ticketDir(spec.ticketId);
    let stop = false;
    const author = (async () => {
      let n = 0;
      while (!stop) {
        writeFileSync(path.join(dev, `f${n % 5}.txt`), `${n++}\n`);
        try {
          git(dev, "add", "-A");
          git(dev, "commit", "-qm", `c${n}`);
          git(dev, "status", "--short");
        } catch {}
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    const out: string[] = [];
    for (let round = 0; round < 8; round++) {
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => ws.ensureReview(spec)));
      out.push(...results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")));
    }
    stop = true;
    await author;
    expect([...new Set(out)]).toEqual(["ok"]);
  }, 120_000);

  // The failure seen on 14 Nov: a git already running in the review copy (a reviewer's agent) holds index.lock.
  it("waits for a lock another git holds and carries on once it is freed", async () => {
    const { ws, spec } = await setup();
    const rev = (await ws.ensureReview(spec)).path;
    const lock = path.join(rev, ".git", "index.lock");
    writeFileSync(lock, "");
    setTimeout(() => rmSync(lock, { force: true }), 1500);
    const t0 = Date.now();
    await expect(ws.ensureReview(spec)).resolves.toMatchObject({ path: rev });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
  }, 120_000);

  it("gives up with git's own reason when the lock is still held at the deadline", async () => {
    const { ws, spec } = await setup();
    ws.reviewLockWaitMs = 800;
    const rev = (await ws.ensureReview(spec)).path;
    writeFileSync(path.join(rev, ".git", "index.lock"), "");
    await expect(ws.ensureReview(spec)).rejects.toThrow(/index\.lock/);
  }, 120_000);

  it("removes a lock a crashed git left behind", async () => {
    const { ws, spec } = await setup();
    const rev = (await ws.ensureReview(spec)).path;
    const lock = path.join(rev, ".git", "index.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    await expect(ws.ensureReview(spec)).resolves.toMatchObject({ path: rev });
    expect(existsSync(lock)).toBe(false);
  }, 120_000);

  it("the first run on a ticket whose review copy doesn't exist yet, and again with it present", async () => {
    const { ws, spec } = await setup();
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled([1, 2, 3, 4].map(() => ws.ensureReview(spec)));
      expect(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))).toEqual(["ok", "ok", "ok", "ok"]);
    }
  }, 120_000);
});
