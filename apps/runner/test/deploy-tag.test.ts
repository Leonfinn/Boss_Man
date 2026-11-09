// DR-033 against a real bare "origin": resolving a deploy's ref, and moving the deploy tag after a
// successful deploy. The tag moves only to a commit on main, never over a hand move, and no branch on
// the remote ever changes.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

/** A bare origin with main at A, the tag live-deployed at A, then main moved on to B, plus an unmerged branch. */
function origin() {
  const bare = mkdtempSync(path.join(tmpdir(), "bm-tag-origin-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(path.join(tmpdir(), "bm-tag-seed-"));
  git(seed, "clone", "-q", bare, ".");
  const commit = (file: string, text: string) => {
    writeFileSync(path.join(seed, file), text);
    git(seed, "add", ".");
    git(seed, "commit", "-qm", `edit ${file}`);
    return git(seed, "rev-parse", "HEAD");
  };
  const A = commit("app.txt", "a\n");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(seed, "tag", "live-deployed", A);
  git(seed, "push", "-q", "origin", "refs/tags/live-deployed");
  const B = commit("app.txt", "b\n");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(seed, "checkout", "-q", "-b", "feature");
  const F = commit("feature.txt", "unmerged\n");
  git(seed, "push", "-q", "origin", "HEAD:feature");
  git(seed, "checkout", "-q", "main");
  const heads = () => git(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const tagAt = (name = "live-deployed") => {
    try {
      return git(bare, "rev-parse", "--verify", "--quiet", `refs/tags/${name}`);
    } catch {
      return null;
    }
  };
  /** Someone moves the tag by hand, straight on the remote. */
  const handMove = (sha: string) => git(bare, "update-ref", "refs/tags/live-deployed", sha);
  return { url: bare, A, B, F, heads, tagAt, handMove };
}

const project = "22222222-2222-4222-8222-222222222222";
const workspaces = () => new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-tag-ws-")));

describe("resolving a deploy's ref (DR-033)", () => {
  it("gives the full sha of a branch, a tag or a short sha, says whether it is on main, and lists the branches", async () => {
    const o = origin();
    const ws = workspaces();
    const spec = { projectId: project, repoUrl: o.url, baseRef: "main" };
    expect(await ws.resolve({ ...spec, ref: "main" })).toMatchObject({ commit: o.B, onBase: true });
    expect(await ws.resolve({ ...spec, ref: o.A.slice(0, 7) })).toMatchObject({ commit: o.A, onBase: true });
    expect(await ws.resolve({ ...spec, ref: "live-deployed" })).toMatchObject({ commit: o.A, onBase: true });
    const f = await ws.resolve({ ...spec, ref: "feature" });
    expect(f).toMatchObject({ commit: o.F, onBase: false });
    expect(f.branches.sort()).toEqual(["feature", "main"]);
  });

  it("names no commit for an image tag, an unknown ref or anything shaped like an option", async () => {
    const o = origin();
    const ws = workspaces();
    const spec = { projectId: project, repoUrl: o.url, baseRef: "main" };
    expect((await ws.resolve({ ...spec, ref: "v9.9.9" })).commit).toBeNull();
    expect((await ws.resolve({ ...spec, ref: "--output=/tmp/x" })).commit).toBeNull();
    expect((await ws.resolve({ ...spec, ref: "registry.lan/app:1.2" })).commit).toBeNull();
  });
});

describe("moving the deploy tag (DR-033)", () => {
  it("moves the remote tag from A to B for a deploy of main's B, and changes no branch", async () => {
    const o = origin();
    const before = o.heads();
    const r = await workspaces().tag({ projectId: project, repoUrl: o.url, name: "live-deployed", commit: o.B, baseRef: "main" });
    expect(r).toEqual({ result: "moved", from: o.A, to: o.B });
    expect(o.tagAt()).toBe(o.B);
    expect(o.heads()).toBe(before);
  });

  it("moves it backwards for a rollback to an older main commit, and creates it when it doesn't exist yet", async () => {
    const o = origin();
    const ws = workspaces();
    await ws.tag({ projectId: project, repoUrl: o.url, name: "live-deployed", commit: o.B, baseRef: "main" });
    expect(await ws.tag({ projectId: project, repoUrl: o.url, name: "live-deployed", commit: o.A, baseRef: "main" })).toEqual({ result: "moved", from: o.B, to: o.A });
    expect(await ws.tag({ projectId: project, repoUrl: o.url, name: "staging-live", commit: o.B, baseRef: "main" })).toEqual({ result: "moved", from: null, to: o.B });
    expect(o.tagAt("staging-live")).toBe(o.B);
    expect(await ws.tag({ projectId: project, repoUrl: o.url, name: "staging-live", commit: o.B, baseRef: "main" })).toEqual({ result: "unchanged", from: o.B, to: o.B });
  });

  it("refuses a commit that isn't on main, and leaves the tag where it is", async () => {
    const o = origin();
    const before = o.heads();
    const r = await workspaces().tag({ projectId: project, repoUrl: o.url, name: "live-deployed", commit: o.F, baseRef: "main" });
    expect(r.result).toBe("refused");
    expect(r.error).toMatch(/isn't on main/);
    expect(o.tagAt()).toBe(o.A);
    expect(o.heads()).toBe(before);
  });

  it("refuses a name that is a branch, a path or not a valid ref, whatever it is sent", async () => {
    const o = origin();
    const ws = workspaces();
    const before = o.heads();
    for (const name of ["main", "feature", "heads/main", "../main", "a..b", "-f", "x y", "x.lock", "HEAD"]) {
      const r = await ws.tag({ projectId: project, repoUrl: o.url, name, commit: o.B, baseRef: "main" });
      expect(r.result, name).toBe("refused");
    }
    expect((await ws.tag({ projectId: project, repoUrl: o.url, name: "live-deployed", commit: "", baseRef: "main" })).result).toBe("refused");
    expect(o.heads()).toBe(before);
    expect(o.tagAt()).toBe(o.A);
  });

  it("doesn't overwrite a tag moved by hand between the read and the push, and says so", async () => {
    const o = origin();
    const ws = workspaces();
    const before = o.heads();
    // The hand move lands right after the daemon reads the tag: hook the daemon's own ls-remote of the tag.
    const inner = ws as unknown as { gitCode: (args: string[], opts: object) => Promise<{ code: number; stdout: string; stderr: string }> };
    const real = inner.gitCode.bind(ws);
    let reads = 0;
    inner.gitCode = async (args, opts) => {
      const out = await real(args, opts);
      if (args[0] === "ls-remote" && args.includes("refs/tags/live-deployed") && ++reads === 1) o.handMove(o.F);
      return out;
    };
    const r = await ws.tag({ projectId: project, repoUrl: o.url, name: "live-deployed", commit: o.B, baseRef: "main" });
    expect(r.result).toBe("failed");
    expect(r.error).toMatch(/Someone else moved live-deployed/);
    expect(o.tagAt()).toBe(o.F);
    expect(o.heads()).toBe(before);
  });

  it("reports the git host's refusal as a failure, with its text", async () => {
    const o = origin();
    // A host that refuses tag updates: a server-side hook, as a protected-tag rule would.
    writeFileSync(path.join(o.url, "hooks", "update"), "#!/bin/sh\necho 'protected tag: updates are not allowed' >&2\nexit 1\n", { mode: 0o755 });
    const r = await workspaces().tag({ projectId: project, repoUrl: o.url, name: "live-deployed", commit: o.B, baseRef: "main" });
    expect(r.result).toBe("failed");
    expect(r.error).toMatch(/protected tag/);
    expect(o.tagAt()).toBe(o.A);
  });
});

describe("the runner commands (DR-033)", () => {
  it("fetches the token as deploy_tag for a tag move, as merge for a resolve, and answers with the result", async () => {
    const o = origin();
    const purposes: string[] = [];
    const replies: Array<{ id: string; r: { ok: boolean; data?: unknown; error?: string } }> = [];
    const m = new SessionManager({
      mcpUrl: "http://127.0.0.1:1/mcp",
      resolveEnv: async () => ({}),
      emit: () => {},
      workspaces: workspaces(),
      resolveCompanyEnv: async (purpose) => (purposes.push(purpose), {}),
      reply: (id, r) => replies.push({ id, r }),
    });
    const settle = async (n: number) => {
      for (let i = 0; i < 200 && replies.length < n; i++) await new Promise((res) => setTimeout(res, 25));
    };
    m.handle({ type: "workspace.resolve", requestId: "r1", projectId: project, repoUrl: o.url, ref: "main", baseRef: "main" });
    await settle(1);
    m.handle({ type: "workspace.tag", requestId: "r2", projectId: project, repoUrl: o.url, name: "live-deployed", commit: o.B, baseRef: "main" });
    await settle(2);
    expect(purposes).toEqual(["merge", "deploy_tag"]);
    expect(replies[0]).toMatchObject({ id: "r1", r: { ok: true, data: { commit: o.B, onBase: true } } });
    expect(replies[1]).toMatchObject({ id: "r2", r: { ok: true, data: { result: "moved", from: o.A, to: o.B } } });
    expect(o.tagAt()).toBe(o.B);
  });
});

describe("a deploy run's environment (BOS-322, DR-033)", () => {
  it("still holds no git credential, even when the deploy target's grants name one", () => {
    const start = { type: "run.start", runId: randomUUID(), agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: randomUUID(), cwd: "/tmp", prompt: "Deploy x is approved: ship main", mcpToken: "bm_x" } as const;
    const m = new SessionManager({ mcpUrl: "http://127.0.0.1:1/mcp", baseEnv: { PATH: "/usr/bin" }, resolveEnv: async () => ({}), emit: () => {} });
    // What /api/runner/env gives a deploy run: the company grants plus the target's own (option 3 of DR-033, refused).
    const secrets = { GIT_TOKEN: "ghp_company", GITEA_TOKEN: "gitea_target", GH_TOKEN: "gh_target", DEPLOY_SSH_KEY: "ssh-key" };
    const env = (m as unknown as { launchEnv: (c: typeof start, s: Record<string, string>) => NodeJS.ProcessEnv }).launchEnv(start, secrets);
    const blob = JSON.stringify(env);
    for (const v of ["ghp_company", "gitea_target", "gh_target"]) expect(blob).not.toContain(v);
    expect(env.DEPLOY_SSH_KEY).toBe("ssh-key");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
