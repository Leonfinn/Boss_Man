// BOS-853: a ticket's copy has a current origin/main at the start of every run, and the agent's own `git fetch`
// in it works with no git login, reading from the shared repo. For both kinds of copy (worktree and clone), and for
// copies made before the change.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addGitConfig } from "../src/fence.js";
import { hasCredential, isClone, NO_PUSH_URL, Workspaces } from "../src/workspace.js";

const ID = { NAME: "t", EMAIL: "t@t" };
const ENV = { ...process.env, GIT_AUTHOR_NAME: ID.NAME, GIT_AUTHOR_EMAIL: ID.EMAIL, GIT_COMMITTER_NAME: ID.NAME, GIT_COMMITTER_EMAIL: ID.EMAIL };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

const ids = { project: "33333333-3333-4333-8333-333333333333", ticket: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };

function upstream() {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-remote-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "v1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "v1");
  git(dir, "tag", "v1");
  return dir;
}

function commitUpstream(dir: string, text: string) {
  writeFileSync(path.join(dir, "README.md"), `${text}\n`);
  git(dir, "commit", "-q", "-am", text);
  return git(dir, "rev-parse", "HEAD");
}

/**
 * The agent's git as a session runs it: only PATH and HOME from outside (no GIT_TOKEN, no auth header, no prompts),
 * plus what the runner adds for the copy.
 */
function sessionGit(ws: Workspaces, cwd: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: mkdtempSync(path.join(tmpdir(), "bm-home-")), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", ...ID_ENV };
  for (const [k, v] of ws.copyGitConfig(ids.project)) addGitConfig(env, k, v);
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, env };
}
const ID_ENV = { GIT_AUTHOR_NAME: ID.NAME, GIT_AUTHOR_EMAIL: ID.EMAIL, GIT_COMMITTER_NAME: ID.NAME, GIT_COMMITTER_EMAIL: ID.EMAIL };

afterEach(() => vi.restoreAllMocks());

for (const copies of ["worktree", "clone"] as const) {
  describe(`a ticket's ${copies} gets a fresh origin (BOS-853)`, () => {
    async function setup() {
      const url = upstream();
      const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")), { ...process.env, BOSSMAN_TICKET_COPIES: copies === "clone" ? "clone" : "" });
      const spec = { projectId: ids.project, ticketId: ids.ticket, repoUrl: url, baseRef: "main" };
      const dir = (await ws.ensure(spec)).path;
      expect(isClone(dir)).toBe(copies === "clone");
      return { url, ws, spec, dir, repo: ws.repoDir(ids.project) };
    }

    it("starts the next run with upstream's new main and tags, with no fetch by the agent", async () => {
      const { url, ws, spec, dir } = await setup();
      const tip = commitUpstream(url, "v2");
      git(url, "tag", "v2");
      expect(git(dir, "rev-parse", "refs/remotes/origin/main")).not.toBe(tip);
      const again = await ws.ensure(spec);
      expect(again.created).toBe(false);
      expect(git(dir, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
      expect(git(dir, "rev-parse", "refs/tags/v2^{commit}")).toBe(tip);
    });

    it("lets the agent's `git fetch` and `git fetch origin` work with no login, from the shared repo", async () => {
      const { url, ws, spec, dir, repo } = await setup();
      const old = git(dir, "rev-parse", "refs/remotes/origin/main");
      const tip = commitUpstream(url, "v2");
      await ws.ensure(spec);
      // The upstream is now out of reach (as GitHub is to a session with no login): only the shared repo can answer.
      renameSync(url, `${url}.gone`);
      if (copies === "clone") git(dir, "update-ref", "refs/remotes/origin/main", old);
      for (const args of [["fetch"], ["fetch", "origin"]]) {
        const r = sessionGit(ws, dir, ...args);
        expect(r.out).not.toMatch(/Username|could not read|does not appear to be a git repository/);
        expect(r.code).toBe(0);
        expect(git(dir, "rev-parse", "refs/remotes/origin/main")).toBe(git(repo, "rev-parse", "refs/remotes/origin/main"));
        expect(git(dir, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
      }
      // A worktree's fetch writes into the shared repo itself: it must bring nothing but origin's branches there.
      expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/")).toBe("refs/remotes/origin/main");
      // Without the runner's config the same fetch goes to the upstream address and fails, as it did before BOS-853.
      const plain = spawnSync("git", ["fetch", "origin"], { cwd: dir, env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8" });
      expect(plain.status).not.toBe(0);
    });

    it("still starts the run when the upstream can't be reached, with the copy's origin/main and one log line", async () => {
      const { url, ws, spec, dir } = await setup();
      const before = git(dir, "rev-parse", "refs/remotes/origin/main");
      renameSync(url, `${url}.gone`);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const again = await ws.ensure(spec);
      expect(again.path).toBe(dir);
      expect(git(dir, "rev-parse", "refs/remotes/origin/main")).toBe(before);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("BOS-853"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/couldn't refresh project .* from upstream at run start/);
      // The agent's own fetch still works, from what the shared repo has.
      expect(sessionGit(ws, dir, "fetch").code).toBe(0);
    });

    it("leaves the copy's branch, HEAD, uncommitted and untracked files and shared/* refs as they were", async () => {
      const { url, ws, spec, dir } = await setup();
      writeFileSync(path.join(dir, "work.txt"), "committed\n");
      git(dir, "add", "work.txt");
      git(dir, "commit", "-q", "-m", "work");
      writeFileSync(path.join(dir, "README.md"), "edited, not committed\n");
      writeFileSync(path.join(dir, "untracked.txt"), "untracked\n");
      if (copies === "clone") git(dir, "fetch", "-q", "shared");
      const state = () => ({
        head: git(dir, "rev-parse", "HEAD"),
        branch: git(dir, "symbolic-ref", "HEAD"),
        status: git(dir, "status", "--porcelain"),
        readme: readFileSync(path.join(dir, "README.md"), "utf8"),
        untracked: readFileSync(path.join(dir, "untracked.txt"), "utf8"),
        shared: git(dir, "for-each-ref", "refs/remotes/shared/"),
      });
      const before = state();
      if (copies === "clone") expect(before.shared).not.toBe("");
      commitUpstream(url, "v2");
      await ws.ensure(spec);
      expect(state()).toEqual(before);
    });

    it("gives a copy made before BOS-853 (no origin view yet) the same on its next run, with no manual step", async () => {
      const { url, ws, spec, dir, repo } = await setup();
      // What today's code leaves: the copy's origin is the upstream address and there is no origin view.
      rmSync(ws.originViewDir(repo), { recursive: true, force: true });
      expect(ws.copyGitConfig(ids.project)).toEqual([]);
      const tip = commitUpstream(url, "v2");
      await ws.ensure(spec);
      expect(git(dir, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
      renameSync(url, `${url}.gone`);
      const r = sessionGit(ws, dir, "fetch", "origin");
      expect(r.out).toBe("");
      expect(r.code).toBe(0);
    });

    it("puts no credential in the session's env or the copy's config, and a push from the copy changes no ref", async () => {
      const url = upstream();
      const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")), { ...process.env, BOSSMAN_TICKET_COPIES: copies === "clone" ? "clone" : "" });
      const spec = { projectId: ids.project, ticketId: ids.ticket, repoUrl: url, baseRef: "main" };
      const token = "ghp_bos853notarealtoken";
      const dir = (await ws.ensure(spec, { GIT_TOKEN: token })).path;
      await ws.ensure(spec, { GIT_TOKEN: token });
      const repo = ws.repoDir(ids.project);
      const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
      const { env } = sessionGit(ws, dir, "status");
      const envText = JSON.stringify(env);
      expect(envText).not.toContain(token);
      expect(envText).not.toContain(basic);
      expect(envText).not.toMatch(/extraheader|Authorization/i);
      const configs = [path.join(repo, "config"), ...(copies === "clone" ? [path.join(dir, ".git", "config")] : [])];
      for (const file of configs) expect(readFileSync(file, "utf8")).not.toContain(token);

      writeFileSync(path.join(dir, "work.txt"), "work\n");
      git(dir, "add", "work.txt");
      git(dir, "commit", "-q", "-m", "work");
      const refs = () => ({ shared: git(repo, "for-each-ref"), upstream: git(url, "for-each-ref") });
      const before = refs();
      for (const args of [["push", "origin", "HEAD:refs/heads/main"], ["push", "origin", "HEAD:refs/heads/pushed"], ["push", "--tags", "origin"]]) {
        const r = sessionGit(ws, dir, ...args);
        expect(r.code).not.toBe(0);
        expect(r.out).toContain(NO_PUSH_URL);
      }
      expect(refs()).toEqual(before);
    });

    it("reviewers' copies get the same refresh and the same login-free fetch", async () => {
      const { url, ws, spec, dir } = await setup();
      git(dir, "commit", "-q", "--allow-empty", "-m", "work");
      const review = (await ws.ensureReview({ ...spec, review: true } as typeof spec)).path;
      const tip = commitUpstream(url, "v2");
      await ws.ensureReview({ ...spec, review: true } as typeof spec);
      expect(git(review, "rev-parse", "refs/remotes/origin/main")).toBe(tip);
      renameSync(url, `${url}.gone`);
      expect(sessionGit(ws, review, "fetch", "origin").code).toBe(0);
    });
  });
}

describe("copyGitConfig (BOS-853)", () => {
  it("never hands a session an address that carries a credential", () => {
    expect(hasCredential("https://x-access-token:abc@github.com/o/r")).toBe(true);
    expect(hasCredential("https://user@github.com/o/r")).toBe(true);
    expect(hasCredential("https://github.com/o/r")).toBe(false);
    expect(hasCredential("/srv/repo")).toBe(false);
    expect(hasCredential("git@github.com:o/r.git")).toBe(false);
    expect(hasCredential("ssh://git@github.com/o/r.git")).toBe(false);
  });

  it("gives nothing for a project with no shared repo yet", () => {
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    expect(ws.copyGitConfig(ids.project)).toEqual([]);
    expect(existsSync(ws.originViewDir(ws.repoDir(ids.project)))).toBe(false);
  });
});
