// BOS-1436 (DR-060 part 2): a check job's code goes from the company runner to a check worker as a git bundle. Real git
// in temp repos: the runner packs, the "upload" is a file copy, the worker takes it and runs the job's check.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerMessage } from "@boss-man/shared";
import { bundleFetcher } from "../src/check-bundle-fetch.js";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
const projectId = "11111111-1111-4111-8111-111111111111";
const job = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An origin with main, a developer clone to commit in, the company runner's shared repo, and an empty worker. */
function setup() {
  const origin = tmp("bm-cb-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const dev = tmp("bm-cb-dev-");
  git(dev, "clone", "-q", origin, ".");
  git(dev, "checkout", "-q", "-b", "main");
  for (let i = 0; i < 5; i++) {
    writeFileSync(path.join(dev, `base${i}.txt`), `${"x".repeat(2000)}${i}\n`);
    git(dev, "add", ".");
    git(dev, "commit", "-qm", `base ${i}`);
  }
  git(dev, "push", "-q", "origin", "HEAD:main");
  const runnerRoot = tmp("bm-cb-runner-");
  mkdirSync(path.join(runnerRoot, "repos"), { recursive: true });
  const runnerRepo = path.join(runnerRoot, "repos", `${projectId}.git`);
  git(runnerRoot, "clone", "-q", "--bare", origin, runnerRepo);
  git(runnerRepo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  const fetch = () => git(runnerRepo, "fetch", "-q", "origin");
  fetch();
  const workerRoot = tmp("bm-cb-worker-");
  // One second apart, so "newest first" by commit date is well defined (they'd all share one second otherwise).
  let at = 1_800_000_000;
  const commit = (file: string, branch: string) => {
    git(dev, "checkout", "-q", branch);
    writeFileSync(path.join(dev, file), `${file}\n`);
    git(dev, "add", ".");
    execFileSync("git", ["commit", "-qm", file], { cwd: dev, env: { ...ENV, GIT_COMMITTER_DATE: `${at++} +0000` } });
    git(dev, "push", "-q", "origin", `HEAD:${branch}`);
    fetch();
    return git(dev, "rev-parse", "HEAD");
  };
  return { dev, origin, runnerRepo, fetch, commit, runner: new Workspaces(runnerRoot, process.env), worker: new Workspaces(workerRoot, process.env), workerRepo: path.join(workerRoot, "repos", `${projectId}.git`) };
}

/** The runner packs; the "upload" keeps a copy of the file, as the server would. */
async function pack(runner: Workspaces, spec: { jobId: string; commit: string; haves?: string[]; full?: boolean }) {
  const store = tmp("bm-cb-store-");
  const kept = path.join(store, "b.bundle");
  let uploaded = false;
  const info = await runner.makeCheckBundle({ projectId, jobId: spec.jobId, commit: spec.commit, haves: spec.haves ?? [], full: spec.full ?? false }, async (file, meta) => {
    copyFileSync(file, kept);
    uploaded = true;
    expect(meta.bytes).toBeGreaterThan(0);
  });
  return { info, file: uploaded ? kept : null };
}

describe("check bundles: runner to worker (BOS-1436)", () => {
  it("seeds an empty worker with a full bundle, then a later job arrives thin and checks out exactly its commit", async () => {
    const s = setup();
    git(s.dev, "checkout", "-q", "-b", "feature");
    const c1 = s.commit("one.txt", "feature");

    const full = await pack(s.runner, { jobId: job(1), commit: c1 });
    expect(full.info.empty).toBe(false);
    expect(full.info.mainRef).toBe("refs/remotes/origin/main");
    expect(full.info.mainCommit).toBe(git(s.runnerRepo, "rev-parse", "refs/remotes/origin/main"));
    // The runner's temporary ref is gone again.
    expect(git(s.runnerRepo, "for-each-ref", "refs/bossman/bundle/")).toBe("");

    expect(await s.worker.takeCheckBundle({ projectId, jobId: job(1), commit: c1, mainRef: full.info.mainRef, mainCommit: full.info.mainCommit }, full.file)).toEqual({ ok: true });
    const r1 = await s.worker.runCommitCheck({ projectId, jobId: job(1), commit: c1 }, "git rev-parse HEAD; git diff --name-only origin/main...HEAD", 60_000);
    expect(r1.ok).toBe(true);
    expect(r1.output).toContain(c1);
    expect(r1.output.trim().split("\n").slice(-1)[0]).toBe("one.txt");

    // Main moves on and the branch gets another commit: the worker's haves make the next bundle thin.
    git(s.dev, "checkout", "-q", "main");
    s.commit("main2.txt", "main");
    const c2 = s.commit("two.txt", "feature");
    const [repo] = await s.worker.checkBundleHaves();
    expect(repo!.projectId).toBe(projectId);
    expect(repo!.haves).toContain(c1);

    const thin = await pack(s.runner, { jobId: job(2), commit: c2, haves: repo!.haves });
    expect(thin.info.empty).toBe(false);
    expect(thin.info.bytes).toBeLessThan(full.info.bytes);
    // Thin: it names prerequisites a fresh repo wouldn't have.
    expect(git(s.runnerRepo, "bundle", "list-heads", thin.file!)).toContain(`refs/bossman/bundle/${job(2)}`);
    expect(await s.worker.takeCheckBundle({ projectId, jobId: job(2), commit: c2, mainRef: thin.info.mainRef, mainCommit: thin.info.mainCommit }, thin.file)).toEqual({ ok: true });
    const r2 = await s.worker.runCommitCheck({ projectId, jobId: job(2), commit: c2 }, "git rev-parse HEAD; git diff --name-only origin/main...HEAD | sort | tr '\\n' ' '", 60_000);
    expect(r2.output).toContain(c2);
    expect(r2.output).toContain("one.txt two.txt");
    expect(r2.output).not.toContain("main2.txt");

    // The same commit again: the worker has everything, so nothing is uploaded and the job still finds its commit.
    const again = await pack(s.runner, { jobId: job(3), commit: c2, haves: (await s.worker.checkBundleHaves())[0]!.haves });
    expect(again.info.empty).toBe(true);
    expect(again.file).toBeNull();
    expect(await s.worker.takeCheckBundle({ projectId, jobId: job(3), commit: c2, mainRef: again.info.mainRef, mainCommit: again.info.mainCommit }, null)).toEqual({ ok: true });
  });

  it("a merge job's commit (only in the runner's repo, two parents) arrives with origin/main, so the diff matches the runner's", async () => {
    const s = setup();
    git(s.dev, "checkout", "-q", "-b", "feature");
    s.commit("feat.txt", "feature");
    git(s.dev, "checkout", "-q", "main");
    s.commit("other.txt", "main");
    // As the merge train's prepare does: a merge commit kept under a private ref of the runner's repo, never pushed.
    git(s.dev, "merge", "-q", "--no-ff", "-m", "merge", "origin/feature");
    const merge = git(s.dev, "rev-parse", "HEAD");
    git(s.dev, "push", "-q", s.runnerRepo, `HEAD:refs/bossman/merge/${job(9)}`);
    git(s.dev, "reset", "-q", "--hard", "origin/main");
    expect(git(s.runnerRepo, "rev-list", "--parents", "-n1", merge).split(" ")).toHaveLength(3);

    const b = await pack(s.runner, { jobId: job(4), commit: merge });
    const diff = "git diff --name-only origin/main...HEAD | sort | tr '\\n' ' '";
    expect(await s.worker.takeCheckBundle({ projectId, jobId: job(4), commit: merge, mainRef: b.info.mainRef, mainCommit: b.info.mainCommit }, b.file)).toEqual({ ok: true });
    const onWorker = await s.worker.runCommitCheck({ projectId, jobId: job(4), commit: merge }, diff, 60_000);
    const onRunner = await s.runner.runCommitCheck({ projectId, jobId: job(5), commit: merge }, diff, 60_000);
    expect(onWorker.ok).toBe(true);
    expect(onWorker.output.trim()).toBe("feat.txt");
    expect(onWorker.output.trim()).toBe(onRunner.output.trim());
    // The secrets scan reads origin/HEAD or origin/main on the worker too.
    expect(git(s.workerRepo, "rev-parse", "refs/remotes/origin/HEAD")).toBe(b.info.mainCommit);
  });

  it("refuses a bundle whose tips aren't the job's commit and main", async () => {
    // Commit ids are content hashes, so "the job's commit is here" is the proof that matters; a head naming another
    // commit, or a job commit that never arrives, is refused.
    const s = setup();
    git(s.dev, "checkout", "-q", "-b", "feature");
    const c1 = s.commit("one.txt", "feature");
    const b = await pack(s.runner, { jobId: job(1), commit: c1 });
    const main = b.info.mainCommit;
    expect(await s.worker.takeCheckBundle({ projectId, jobId: job(1), commit: main, mainRef: b.info.mainRef, mainCommit: main }, b.file)).toMatchObject({ ok: false, missing: false });
    expect(await s.worker.takeCheckBundle({ projectId, jobId: job(1), commit: c1, mainRef: b.info.mainRef, mainCommit: c1 }, b.file)).toMatchObject({ ok: false, missing: false });
    const c2 = s.commit("two.txt", "feature");
    expect(await s.worker.takeCheckBundle({ projectId, jobId: job(2), commit: c2, mainRef: b.info.mainRef, mainCommit: main }, b.file)).toMatchObject({ ok: false, missing: true });
    expect(git(s.workerRepo, "for-each-ref", "refs/bossman/jobs/")).toBe("");
  });

  it("a thin bundle whose base the worker lacks asks once for the full history; a second miss gives up (back in line, not a failed check)", async () => {
    const s = setup();
    git(s.dev, "checkout", "-q", "-b", "feature");
    const c1 = s.commit("one.txt", "feature");
    const c2 = s.commit("two.txt", "feature");
    const sent: WorkerMessage[] = [];
    const files = new Map<string, string>();
    const prepare = bundleFetcher({
      workspaces: s.worker,
      download: async (jobId, file) => {
        copyFileSync(files.get(jobId)!, file);
        return null;
      },
      send: (m) => void sent.push(m),
    });
    // The server thought the worker had c1 (it doesn't: say its disk was wiped): a thin bundle on top of c1.
    const thin = await pack(s.runner, { jobId: job(1), commit: c2, haves: [c1] });
    files.set(job(1), thin.file!);
    const cmd = { jobId: job(1), projectId, commit: c2, command: "true", bundle: thin.info };
    expect(await prepare(cmd)).toBe(false);
    expect(sent).toEqual([{ type: "check.needCode", jobId: job(1) }]);

    // The full history arrives: taken, and the worker reports what it holds now.
    const full = await pack(s.runner, { jobId: job(1), commit: c2, full: true });
    files.set(job(1), full.file!);
    expect(await prepare({ ...cmd, bundle: full.info })).toBe(true);
    expect(sent[1]).toMatchObject({ type: "check.haves", repos: [{ projectId, haves: expect.arrayContaining([c2]) }] });

    // Another job: thin again, base missing twice (the server re-sent a thin one): it gives up the second time.
    const c3 = s.commit("three.txt", "feature");
    const bogus = await pack(s.runner, { jobId: job(2), commit: c3, haves: [c2] });
    rmSync(s.workerRepo, { recursive: true, force: true });
    files.set(job(2), bogus.file!);
    const cmd2 = { jobId: job(2), projectId, commit: c3, command: "true", bundle: bogus.info };
    expect(await prepare(cmd2)).toBe(false);
    expect(await prepare(cmd2)).toBe(false);
    expect(sent.slice(2)).toEqual([
      { type: "check.needCode", jobId: job(2) },
      { type: "check.noCode", jobId: job(2), reason: expect.stringContaining("doesn't have") },
    ]);
  });

  it("a download that fails gives up at once, without asking for the full history", async () => {
    const s = setup();
    const sent: WorkerMessage[] = [];
    const prepare = bundleFetcher({ workspaces: s.worker, download: async () => "the server didn't give the code (HTTP 404)", send: (m) => void sent.push(m) });
    const main = git(s.runnerRepo, "rev-parse", "refs/remotes/origin/main");
    const ok = await prepare({ jobId: job(1), projectId, commit: main, command: "true", bundle: { sha256: "a".repeat(64), bytes: 10, mainRef: "refs/remotes/origin/main", mainCommit: main, empty: false } });
    expect(ok).toBe(false);
    expect(sent).toEqual([{ type: "check.noCode", jobId: job(1), reason: "the server didn't give the code (HTTP 404)" }]);
  });

  it("keeps only the newest job refs as its base", async () => {
    const s = setup();
    git(s.dev, "checkout", "-q", "-b", "feature");
    for (let i = 1; i <= 12; i++) {
      const c = s.commit(`f${i}.txt`, "feature");
      const b = await pack(s.runner, { jobId: job(i), commit: c, haves: (await s.worker.checkBundleHaves())[0]?.haves ?? [] });
      expect(await s.worker.takeCheckBundle({ projectId, jobId: job(i), commit: c, mainRef: b.info.mainRef, mainCommit: b.info.mainCommit }, b.file)).toEqual({ ok: true });
    }
    const refs = git(s.workerRepo, "for-each-ref", "--format=%(refname)", "refs/bossman/jobs/").split("\n");
    expect(refs).toHaveLength(10);
    expect(refs).toContain(`refs/bossman/jobs/${job(12)}`);
    expect(refs).not.toContain(`refs/bossman/jobs/${job(1)}`);
  });
});
