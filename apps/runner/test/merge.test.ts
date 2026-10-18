// R46 and R47 against a real bare "origin": merge without a working tree, conflicts,
// uncommitted work, a moving target, and verify commands.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

/** A bare origin plus a scratch clone for pushing "other people's" commits to it. */
function origin() {
  const bare = mkdtempSync(path.join(tmpdir(), "bm-origin-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(path.join(tmpdir(), "bm-seed-"));
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "app.txt"), "line 1\nline 2\nline 3\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const pushChange = (file: string, content: string) => {
    git(seed, "pull", "-q", "origin", "main");
    writeFileSync(path.join(seed, file), content);
    git(seed, "add", ".");
    git(seed, "commit", "-qm", `edit ${file}`);
    git(seed, "push", "-q", "origin", "HEAD:main");
  };
  return { url: bare, pushChange, mainSha: () => git(bare, "rev-parse", "main") };
}

const ids = { project: "11111111-1111-4111-8111-111111111111", t: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };

async function ticketWithCommit(o: ReturnType<typeof origin>, file: string, content: string) {
  const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
  const spec = { projectId: ids.project, ticketId: ids.t, repoUrl: o.url, baseRef: "main" };
  const w = await ws.ensure(spec);
  writeFileSync(path.join(w.path, file), content);
  git(w.path, "add", ".");
  git(w.path, "commit", "-qm", "ticket work");
  return { ws, spec, w };
}

describe("merging a ticket's branch (R46)", () => {
  it("merges cleanly into the named target with a merge commit, then reports already merged", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    o.pushChange("other.txt", "someone else\n"); // the target moved since the ticket started
    const r = await ws.merge(spec, "main", "Merge ticket: add feature");
    expect(r.status).toBe("merged");
    expect(o.mainSha()).toBe((r as { commit: string }).commit);
    expect(git(o.url, "log", "-1", "--format=%P", "main").split(" ")).toHaveLength(2);
    expect(git(o.url, "log", "-1", "--format=%s", "main")).toBe("Merge ticket: add feature");
    expect(git(o.url, "show", "main:feature.txt")).toBe("new");
    expect(git(o.url, "show", "main:other.txt")).toBe("someone else");
    expect((await ws.merge(spec, "main", "again")).status).toBe("already_merged");
  });

  it("reports conflicting files without changing the target", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "app.txt", "line 1\nticket's line 2\nline 3\n");
    o.pushChange("app.txt", "line 1\nmain's line 2\nline 3\n");
    const before = o.mainSha();
    expect(await ws.merge(spec, "main", "Merge")).toEqual({ status: "conflicts", files: ["app.txt"] });
    expect(o.mainSha()).toBe(before);
  });

  it("refuses while the worktree has uncommitted work, and never cleans it", async () => {
    const o = origin();
    const { ws, spec, w } = await ticketWithCommit(o, "feature.txt", "new\n");
    writeFileSync(path.join(w.path, "draft.txt"), "not committed\n");
    expect(await ws.merge(spec, "main", "Merge")).toEqual({ status: "uncommitted", files: ["draft.txt"] });
    expect(git(w.path, "status", "--porcelain")).toBe("?? draft.txt");
  });
});

describe("pushing a ticket's branch for a pull request (R59)", () => {
  it("pushes the branch without touching the target, and refuses conflicts and uncommitted work", async () => {
    const o = origin();
    const { ws, spec, w } = await ticketWithCommit(o, "feature.txt", "new\n");
    const before = o.mainSha();
    const r = await ws.pushForReview(spec, "main");
    expect(r).toEqual({ status: "pushed", branch: `bossman/${ids.t}`, commit: git(w.path, "rev-parse", "HEAD") });
    expect(git(o.url, "rev-parse", `bossman/${ids.t}`)).toBe(git(w.path, "rev-parse", "HEAD"));
    expect(o.mainSha()).toBe(before);

    writeFileSync(path.join(w.path, "draft.txt"), "not committed\n");
    expect(await ws.pushForReview(spec, "main")).toEqual({ status: "uncommitted", files: ["draft.txt"] });
  });

  it("reports conflicts with the target instead of pushing", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "app.txt", "line 1\nticket's line 2\nline 3\n");
    o.pushChange("app.txt", "line 1\nmain's line 2\nline 3\n");
    expect(await ws.pushForReview(spec, "main")).toEqual({ status: "conflicts", files: ["app.txt"] });
    expect(() => git(o.url, "rev-parse", "--verify", "--quiet", `refs/heads/bossman/${ids.t}`)).toThrow();
  });
});

describe("proposing merge checks (R57)", () => {
  it("reads the default branch's files from the clone, without a worktree, and reports the runner's tools", async () => {
    const o = origin();
    const seed = mkdtempSync(path.join(tmpdir(), "bm-detect-"));
    git(seed, "clone", "-q", o.url, ".");
    writeFileSync(path.join(seed, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest run" } }));
    writeFileSync(path.join(seed, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "node project");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const ws = new Workspaces(mkdtempSync(path.join(tmpdir(), "bm-ws-root-")));
    const r = await ws.detect({ projectId: ids.project, repoUrl: o.url, baseRef: "main" });
    expect(r.checks.map((c) => c.command)).toEqual(["pnpm install --frozen-lockfile && pnpm typecheck && pnpm test"]);
    expect(r.tools.node).toBe(true);
    expect(typeof r.tools.cargo).toBe("boolean");
  });
});

describe("verify before done (R47)", () => {
  it("passes or fails on the command's exit code, with the tail of its output", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "feature.txt", "new\n");
    const ok = await ws.verify(spec, "test -f feature.txt && echo checks passed");
    expect(ok).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(ok.output).toContain("checks passed");
    const bad = await ws.verify(spec, "echo 2 tests failed >&2; exit 3");
    expect(bad).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
    expect(bad.output).toContain("2 tests failed");
    expect(await ws.verify(spec, "sleep 5", 200)).toMatchObject({ ok: false, timedOut: true });
  });
});
