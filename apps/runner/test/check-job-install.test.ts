// BOS-798: a server-queued quick check runs in a fresh worktree with no node_modules, so the job installs first;
// a check-all command installs for itself and is left alone. A stub pnpm stands in for the real one.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

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

function setup(withLockfile: boolean) {
  const bare = tmp("bm-cji-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-cji-seed-");
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "a.txt"), "a\n");
  if (withLockfile) writeFileSync(path.join(seed, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const root = tmp("bm-cji-root-");
  mkdirSync(path.join(root, "repos"), { recursive: true });
  git(root, "clone", "-q", "--bare", bare, path.join(root, "repos", `${projectId}.git`));
  // A pnpm that records its arguments and makes node_modules, as a real install would.
  const bin = tmp("bm-cji-bin-");
  const stub = path.join(bin, "pnpm");
  writeFileSync(stub, '#!/bin/sh\necho "pnpm $*"\nmkdir -p node_modules\n');
  chmodSync(stub, 0o755);
  const ws = new Workspaces(root, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  return { ws, commit: git(seed, "rev-parse", "HEAD") };
}

describe("queued check job installs packages", () => {
  it("installs from the lockfile before a quick-check command, so node_modules exists when it runs", async () => {
    const { ws, commit } = setup(true);
    const r = await ws.runCommitCheck({ projectId, jobId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", commit }, "test -d node_modules && echo tools-found", 60_000);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("pnpm install --frozen-lockfile --prefer-offline");
    expect(r.output).toContain("tools-found");
  });

  it("does not install for a check-all command, which installs for itself", async () => {
    const { ws, commit } = setup(true);
    const r = await ws.runCommitCheck({ projectId, jobId: "ffffffff-ffff-4fff-8fff-ffffffffffff", commit }, "echo scripts/check-all.sh; test ! -d node_modules && echo no-install", 60_000);
    expect(r.output).toContain("no-install");
  });

  it("does not install in a project without a pnpm lockfile", async () => {
    const { ws, commit } = setup(false);
    const r = await ws.runCommitCheck({ projectId, jobId: "99999999-9999-4999-8999-999999999999", commit }, "test ! -d node_modules && echo no-install", 60_000);
    expect(r.output).toContain("no-install");
  });
});
