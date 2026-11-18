// The runner's own git in a ticket's clone, fenced (BOS-323 step 4): every workspace and merge test
// again with clones and the fence on, then what the fence adds. A program the clone's own config
// names (a clean filter, an fsmonitor) is held to the clone if it runs (BOS-332's config guard now
// removes the known ones first, fenced or not); and an agent fenced in a clone can't write the shared repo at all. Needs Landlock.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  await import("./merge-check.test.js");
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

  // Before BOS-332 this was the control (unfenced, the filter ran). Now the config guard removes the planted keys
  // before the runner's git runs, so even unfenced (an `unavailable` host) nothing runs, and every job still works.
  it("the same planted filter doesn't run when the runner's git isn't fenced either: the config guard removes it (BOS-332)", async () => {
    const { ws, spec, dir } = await ticket(false);
    const { out: outside, cp, savedPatch } = await lifecycle(ws, spec, dir, () => plant(dir));
    expect(readdirSync(outside)).toEqual([]);
    expect(cp?.files).toBe(1);
    expect(savedPatch).toBe(true);
  });

  // Jane's finding on BOS-321: an agent swaps its clone's `.git` for a pointer at a git dir it controls (outside the clone)
  // whose config names a filter; the runner's git, discovering the repo from the folder, must not run it outside the fence.
  async function pointed(fenced: boolean) {
    const { ws, spec, dir } = await ticket(fenced);
    const outside = mkdtempSync(path.join(tmpdir(), "bm-outside-"));
    const evilGit = path.join(mkdtempSync(path.join(tmpdir(), "bm-evil-")), "git");
    cpSync(path.join(dir, ".git"), evilGit, { recursive: true });
    git(dir, "--git-dir", evilGit, "config", "core.worktree", dir);
    git(dir, "--git-dir", evilGit, "config", "filter.planted.clean", `sh -c 'touch ${outside}/filter; cat'`);
    writeFileSync(path.join(evilGit, "info", "attributes"), "* filter=planted\n");
    writeFileSync(path.join(dir, "left.txt"), "uncommitted\n");
    rmSync(path.join(dir, ".git"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    writeFileSync(path.join(dir, ".git"), `gitdir: ${evilGit}\n`);
    await ws.checkpoint(spec, "after a turn").catch(() => undefined);
    await ws.diff(spec).catch(() => undefined);
    return outside;
  }

  it("holds the runner's git to the fence when the clone's .git is swapped for a pointer to a git dir the agent controls", async () => {
    expect(readdirSync(await pointed(true))).toEqual([]);
  });

  // Was the control before BOS-332: the runner's git no longer follows a ticket folder's .git pointer at all
  // (a .git file must lead to a worktree admin folder the repo confirms), so unfenced it's refused and nothing runs.
  it("the same swapped pointer runs nothing when the runner's git isn't fenced either: the pointer isn't followed (BOS-332)", async () => {
    expect(readdirSync(await pointed(false))).toEqual([]);
  });

  // BOS-332's own check comes first now (git only in one of the runner's repos), so the error is that one; either way it's refused.
  it("refuses git in a clone without the shared repo to fence it with", async () => {
    const { ws, dir } = await ticket(true);
    await expect((ws as unknown as { git(a: string[], o: object): Promise<string> }).git(["status"], { cwd: dir })).rejects.toThrow(/can't be fenced|only runs in one of its own repos/);
  });

  // BOS-1470: a failed fenced git used to surface only as "Command failed: perl .../landlock.pl --ro ...", with no reason.
  it("says why a fenced git failed (its stderr and exit code), not only the fence command line", async () => {
    const { ws, dir, repo } = await ticket(true);
    const err = await (ws as unknown as { git(a: string[], o: object): Promise<string> })
      .git(["rev-parse", "--verify", "refs/heads/no-such-branch-1470"], { cwd: dir, repo })
      .then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/^fenced git rev-parse failed \(exit \d+\): .*no-such-branch-1470|^fenced git rev-parse failed \(exit \d+\): fatal/);
    expect(err!.message).not.toMatch(/landlock\.pl/);
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

describe.skipIf(!live)("the merge check, fenced when asked (BOS-323)", () => {
  /** A ticket's copy on a runner with check-all's queue folder and a fenced check home, as main.ts sets it up. */
  async function checkable(copies: "clone" | "worktree") {
    const url = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
    git(url, "init", "-q", "-b", "main");
    writeFileSync(path.join(url, "README.md"), "v1\n");
    git(url, "add", ".");
    git(url, "commit", "-q", "-m", "v1");
    const root = mkdtempSync(path.join(tmpdir(), "bm-ws-root-"));
    const ws = new Workspaces(root, { ...process.env, BOSSMAN_TICKET_COPIES: copies }, path.join(root, ".bossman-coord"));
    ws.checkFence = { home: path.join(root, "agents", "merge-check"), pnpmStore: path.join(root, ".pnpm-store") };
    const spec = { projectId: ids.project, ticketId: ids.a, repoUrl: url, baseRef: "main" };
    const dir = (await ws.ensure(spec)).path;
    // Stand-ins for what the daemon holds: its token beside the workspaces, and a sibling folder.
    const secret = path.join(mkdtempSync(path.join(tmpdir(), "bm-runner-data-")), "token");
    writeFileSync(secret, "runner-token\n");
    return { ws, spec, dir, root, secret, outside: mkdtempSync(path.join(tmpdir(), "bm-outside-")) };
  }

  for (const copies of ["clone", "worktree"] as const) {
    it(`keeps a fenced check to the ticket's ${copies}, its home and temp folder, and it still runs pnpm`, async () => {
      const { ws, spec, dir, root, secret, outside } = await checkable(copies);
      const script = [
        'echo "home=$HOME"',
        'touch "$TMPDIR/t" && echo tmp-ok',
        "touch built.txt && echo copy-ok",
        `touch ${outside}/x 2>/dev/null && echo outside-written`,
        `cat ${secret} 2>/dev/null && echo token-read`,
        "pnpm --version >/dev/null && echo pnpm-ok",
        "git status --porcelain >/dev/null && echo git-ok",
      ].join("; ");
      const res = await ws.verify(spec, script, undefined, undefined, true);
      expect(res).toMatchObject({ ok: true, fenced: true });
      expect(res.output).toMatch(new RegExp(`home=${path.join(root, "agents", "merge-check", "tmp")}/check-[^/]+/home\\n`));
      for (const ok of ["tmp-ok", "copy-ok", "pnpm-ok", "git-ok"]) expect(res.output).toContain(ok);
      expect(res.output).not.toContain("outside-written");
      expect(res.output).not.toContain("runner-token");
      expect(existsSync(path.join(dir, "built.txt"))).toBe(true);
      // The check's temp folder goes with it.
      expect(readdirSync(path.join(root, "agents", "merge-check", "tmp"))).toEqual([]);
    });
  }

  it("takes turns in the same check-all queue as an unfenced check, and can't forge its results", async () => {
    const { ws, spec } = await checkable("clone");
    const show = 'echo "lock=$CHECK_ALL_LOCK store=$BOSSMAN_CHECK_STORE"';
    const plain = await ws.verify(spec, show);
    const fenced = await ws.verify(spec, `${show}; touch "$(dirname "$CHECK_ALL_LOCK")/q" && echo queue-ok; touch "$BOSSMAN_CHECK_STORE/forged" 2>/dev/null && echo forged`, undefined, undefined, true);
    expect(fenced.output.split("\n")[0]).toBe(plain.output.trim());
    expect(fenced.output).toContain("queue-ok");
    expect(fenced.output).not.toContain("forged");
  });

  it("runs as before when the runner can't fence the check, and says so; unasked, nothing changes", async () => {
    const { ws, spec, outside } = await checkable("clone");
    ws.checkFence = null;
    expect(await ws.verify(spec, 'echo "home=$HOME"', undefined, undefined, true)).toMatchObject({ ok: true, fenced: false, output: `home=${process.env.HOME}\n` });
    // Unfenced, the same write outside the copy goes through: what the fenced test refuses is real.
    expect((await ws.verify(spec, `touch ${outside}/x && echo outside-written`, undefined, undefined, true)).output).toContain("outside-written");
    expect(Object.keys(await ws.verify(spec, "true")).sort()).toEqual(["exitCode", "ms", "ok", "output", "timedOut"]);
  });
});
