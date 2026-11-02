// The runner's own git in a ticket's clone, fenced (BOS-323 step 4): every workspace and merge test
// again with clones and the fence on, then what the fence adds. A program the clone's own config
// names (a clean filter, an fsmonitor) still runs for the runner's git there, so it's held to the
// clone; and an agent fenced in a clone can't write the shared repo at all. Needs Landlock.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fencedCommand, fenceProfile, levelFor, probeLandlock, repoGrant } from "../src/fence.js";
import { branchFor, Workspaces } from "../src/workspace.js";

const live = levelFor(probeLandlock().abi).level !== "unavailable";

vi.stubEnv("BOSSMAN_TICKET_COPIES", "clone");
Workspaces.fenceCloneGitByDefault = live;
afterAll(() => {
  vi.unstubAllEnvs();
  Workspaces.fenceCloneGitByDefault = false;
});
if (live) {
  await import("./workspace.test.js");
  await import("./merge.test.js");
}

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

const ids = { project: "11111111-1111-4111-8111-111111111111", a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

async function ticket(fenced: boolean) {
  const url = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
  git(url, "init", "-q", "-b", "main");
  writeFileSync(path.join(url, "README.md"), "v1\n");
  git(url, "add", ".");
  git(url, "commit", "-q", "-m", "v1");
  const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
  ws.fenceCloneGit = fenced;
  const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: url, baseRef: "main" };
  const a = await ws.ensure(spec);
  return { ws, spec, dir: a.path, repo: ws.repoDir(ids.project) };
}

/** The agent plants a clean filter for every file and an fsmonitor in its own clone, each writing a marker outside it. */
function plant(dir: string) {
  const outside = mkdtempSync(path.join(tmpdir(), "bm-outside-"));
  git(dir, "config", "filter.planted.clean", `sh -c 'touch ${outside}/filter; cat'`);
  writeFileSync(path.join(dir, ".git", "info", "attributes"), "* filter=planted\n");
  writeFileSync(path.join(dir, ".git", "fsmon"), `#!/bin/sh\ntouch ${outside}/fsmonitor\nexit 1\n`, { mode: 0o755 });
  git(dir, "config", "core.fsmonitor", path.join(dir, ".git", "fsmon"));
  return outside;
}

/**
 * Everything the runner does in a ticket's copy over a run, after the agent committed and left
 * work uncommitted: a turn checkpoint, a review copy, the diff, release, and the copy put back
 * with its saved work. The agent's own git would run the planted programs too, so it goes first.
 */
async function lifecycle(ws: Workspaces, spec: Awaited<ReturnType<typeof ticket>>["spec"], dir: string, outside: () => string) {
  writeFileSync(path.join(dir, "work.txt"), "work\n");
  git(dir, "add", "work.txt");
  git(dir, "commit", "-qm", "work");
  writeFileSync(path.join(dir, "left.txt"), "uncommitted\n");
  const out = outside();
  const cp = await ws.checkpoint(spec, "after a turn");
  await ws.ensureReview({ ...spec, review: true });
  const diff = await ws.diff(spec);
  const { savedPatch } = await ws.release(spec);
  return { out, cp, diff, savedPatch };
}

describe.skipIf(!live)("the runner's git in a clone, fenced (BOS-323)", () => {
  it("holds a filter or fsmonitor the clone's config names to the clone, and still does every job", async () => {
    const { ws, spec, dir, repo } = await ticket(true);
    const { out: outside, cp, diff, savedPatch } = await lifecycle(ws, spec, dir, () => plant(dir));
    expect(readdirSync(outside)).toEqual([]);
    expect(cp?.files).toBe(1);
    expect(diff.files.map((f) => f.path).sort()).toEqual(["left.txt", "work.txt"]);
    expect(savedPatch).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s", `refs/heads/${branchFor(ids.a)}`)).toBe("work");
    // Nothing of the runner's is left in its temp folder.
    expect(readdirSync(path.join(ws.root, "tmp"))).toEqual([]);
  });

  it("the same planted filter reaches outside the clone when the runner's git isn't fenced", async () => {
    const { ws, spec, dir } = await ticket(false);
    const { out: outside } = await lifecycle(ws, spec, dir, () => plant(dir));
    expect(existsSync(path.join(outside, "filter"))).toBe(true);
  });

  it("refuses git in a clone without the shared repo to fence it with", async () => {
    const { ws, dir } = await ticket(true);
    await expect((ws as unknown as { git(a: string[], o: object): Promise<string> }).git(["status"], { cwd: dir })).rejects.toThrow(/can't be fenced/);
  });

  it("gives an agent fenced in a clone no write to the shared repo, where a worktree's agent may write objects", async () => {
    const { dir, repo } = await ticket(false);
    const home = mkdtempSync(path.join(tmpdir(), "bm-home-"));
    const tryWrite = (cwd: string) => {
      const rules = fenceProfile({ cwd, home, tmp: home, repo: repoGrant(repo, cwd) });
      const cmd = fencedCommand(rules, "/bin/sh", ["-c", 'for d in objects refs logs .; do touch "$1/$d/planted" 2>/dev/null && echo "$d"; done; true', "sh", repo]);
      return spawnSync(cmd.bin, cmd.args, { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    };
    expect(tryWrite(dir)).toEqual([]);
    // The agent's own commits still work: they land in its clone.
    const rules = fenceProfile({ cwd: dir, home, tmp: home, repo: repoGrant(repo, dir) });
    const cmd = fencedCommand(rules, "git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "fenced"]);
    expect(spawnSync(cmd.bin, cmd.args, { cwd: dir, env: { PATH: process.env.PATH, HOME: home } }).status).toBe(0);

    const wt = mkdtempSync(path.join(tmpdir(), "bm-wt-"));
    git(repo, "worktree", "add", "-q", "--detach", path.join(wt, "w"), "HEAD");
    expect(tryWrite(path.join(wt, "w"))).toEqual(["objects", "refs", "logs"]);
  });
});
