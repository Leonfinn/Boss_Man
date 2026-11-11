// BOS-313 (F6): the merge gate checks the merge commit it pushes, not the branch on its own.
// Against a real bare origin: a.txt and b.txt are each fine alone but must not exist together.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspaces } from "../src/workspace.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function origin() {
  const bare = tmp("bm-mc-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-mc-seed-");
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "app.txt"), "line 1\n");
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
  const ws = new Workspaces(tmp("bm-mc-root-"));
  const spec = { projectId: ids.project, ticketId: ids.t, repoUrl: o.url, baseRef: "main" };
  const w = await ws.ensure(spec);
  writeFileSync(path.join(w.path, file), content);
  git(w.path, "add", ".");
  git(w.path, "commit", "-qm", "ticket work");
  return { ws, spec, w };
}

/** Fails only when both branches' files exist together. */
const NOT_BOTH = "test ! \\( -f a.txt -a -f b.txt \\)";

describe("two branches that each pass alone (F6)", () => {
  it("the old path pushes a main that fails the check (the bug)", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "b.txt", "b\n");
    o.pushChange("a.txt", "a\n"); // branch A merged first
    expect((await ws.verify(spec, NOT_BOTH)).ok).toBe(true); // B alone passes
    expect((await ws.merge(spec, "main", "Merge B")).status).toBe("merged");
    expect(git(o.url, "ls-tree", "--name-only", "main").split("\n")).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
  });

  it("with checks, the clash is rejected and main is unchanged", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "b.txt", "b\n");
    o.pushChange("a.txt", "a\n");
    const before = o.mainSha();
    const r = await ws.merge(spec, "main", "Merge B", {}, { commands: [NOT_BOTH] });
    expect(r.status).toBe("check_failed");
    expect(o.mainSha()).toBe(before);
    expect(existsSync(ws.mergeCheckDir(ids.t))).toBe(false);
  });

  it("a clean merge pushes exactly the commit it checked, and says so", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "b.txt", "b\n");
    o.pushChange("c.txt", "c\n");
    const r = await ws.merge(spec, "main", "Merge B", {}, { commands: [NOT_BOTH, "test -f b.txt && test -f c.txt"] });
    expect(r.status).toBe("merged");
    const m = r as { commit: string; checked: { sha: string; tree: string } };
    expect(o.mainSha()).toBe(m.commit);
    expect(m.checked.sha).toBe(m.commit);
    expect(m.checked.tree).toBe(git(o.url, "rev-parse", "main^{tree}"));
    expect(existsSync(ws.mergeCheckDir(ids.t))).toBe(false);
  });

  it("checks again when main moves during the check and the merged tree changes", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "b.txt", "b\n");
    // main gets a.txt while the first check sleeps; the second check on the new merged tree then fails.
    const promise = ws.merge(spec, "main", "Merge B", {}, { commands: [`sleep 1; ${NOT_BOTH}`] });
    await new Promise((r) => setTimeout(r, 700));
    o.pushChange("a.txt", "a\n");
    expect((await promise).status).toBe("check_failed");
    expect(git(o.url, "ls-tree", "--name-only", "main")).not.toContain("b.txt");
  });

  it("keeps the earlier check when main moves but the merged tree is the same", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "b.txt", "b\n");
    const counter = path.join(tmp("bm-mc-count-"), "runs");
    const promise = ws.merge(spec, "main", "Merge B", {}, { commands: [`echo x >> ${counter}; sleep 2`] });
    // Move main only once the check is running: a fixed delay lost the race on a busy runner
    // (the merge's own git calls ran past it, so the check ran on the moved main).
    for (let i = 0; i < 300 && !existsSync(counter); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(counter)).toBe(true);
    // An empty commit changes main's sha but not its tree.
    const noop = git(o.url, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "main^{tree}", "-p", "main", "-m", "noop");
    git(o.url, "update-ref", "refs/heads/main", noop);
    const r = await promise;
    expect(r.status).toBe("merged");
    expect(execFileSync("wc", ["-l", counter], { encoding: "utf8" }).trim().startsWith("1 ")).toBe(true);
    const m = r as { commit: string; checked: { sha: string; tree: string } };
    expect(o.mainSha()).toBe(m.commit);
    // The record names the commit the check ran on, not the new one built on the moved main.
    expect(m.checked.sha).not.toBe(m.commit);
    expect(git(ws.repoDir(ids.project), "rev-parse", `${m.checked.sha}^{tree}`)).toBe(m.checked.tree);
    expect(git(o.url, "show", "main:b.txt")).toBe("b");
  });

  it("removes the temporary worktree after a timeout", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "b.txt", "b\n");
    const r = await ws.merge(spec, "main", "Merge B", {}, { commands: ["sleep 30"], timeoutMs: 300 });
    expect(r).toMatchObject({ status: "check_failed", result: { timedOut: true } });
    expect(existsSync(ws.mergeCheckDir(ids.t))).toBe(false);
  });

  it("a push the origin refuses for good throws git's message instead of looping", async () => {
    const o = origin();
    const { ws, spec } = await ticketWithCommit(o, "b.txt", "b\n");
    const hook = path.join(o.url, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho protected branch >&2\nexit 1\n", { mode: 0o755 });
    await expect(ws.merge(spec, "main", "Merge B", {}, { commands: ["true"] })).rejects.toThrow(/Couldn.t push the merge to main/);
    expect(existsSync(ws.mergeCheckDir(ids.t))).toBe(false);
  });
});

describe("migration journal on the checked path (BOS-360)", () => {
  const journal = (whens: number[]) =>
    JSON.stringify({ version: "7", dialect: "postgresql", entries: whens.map((when, idx) => ({ idx, version: "7", when, tag: String(idx + 1).padStart(4, "0") + "_m", breakpoints: true })) });
  const put = (dir: string, whens: number[]) => {
    mkdirSync(path.join(dir, "drizzle", "meta"), { recursive: true });
    writeFileSync(path.join(dir, "drizzle", "meta", "_journal.json"), journal(whens));
  };

  it("refuses a new migration older than main's newest, and pushes nothing", async () => {
    const o = origin();
    const seed = tmp("bm-mc-seed-");
    git(seed, "clone", "-q", o.url, ".");
    put(seed, [2000]);
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "journal");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const { ws, spec, w } = await ticketWithCommit(o, "b.txt", "b\n");
    git(w.path, "pull", "-q", "--no-rebase", "origin", "main");
    put(w.path, [2000, 1500]);
    git(w.path, "add", ".");
    git(w.path, "commit", "-qm", "old when");
    const before = o.mainSha();
    const r = await ws.merge(spec, "main", "Merge B", {}, { commands: ["true"] });
    expect(r.status).toBe("migration_journal");
    expect(o.mainSha()).toBe(before);
  });
});

describe("the merge gate's pnpm store (BOS-568 review)", () => {
  // The gate runs unfenced as the runner's user, so it must install from its own store, never the shared one
  // agents can write. This pins the wiring in main.ts: the 4th Workspaces argument is the gate's store.
  it("installs from its own store, not the agents' shared one", async () => {
    const o = origin();
    const shared = tmp("bm-mc-shared-");
    const gate = `${shared}-gate`;
    const ws = new Workspaces(tmp("bm-mc-root-"), process.env, undefined, gate);
    const spec = { projectId: ids.project, ticketId: ids.t, repoUrl: o.url, baseRef: "main" };
    const w = await ws.ensure(spec);
    writeFileSync(path.join(w.path, "b.txt"), "b\n");
    git(w.path, "add", ".");
    git(w.path, "commit", "-qm", "ticket work");
    const out = path.join(tmp("bm-mc-seen-"), "store");
    const r = await ws.merge(spec, "main", "Merge B", {}, { commands: [`echo "$npm_config_store_dir" > ${out}`] });
    expect(r.status).toBe("merged");
    expect(existsSync(out) ? execFileSync("cat", [out], { encoding: "utf8" }).trim() : "").toBe(gate);
  });
});
