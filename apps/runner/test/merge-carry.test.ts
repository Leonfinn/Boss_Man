// BOS-1762, runner side, against a real bare "origin": finish with `carry` lands a passed merge on a main that moved since
// prepare when main's new commits touch none of the ticket's files (and nothing that re-tests the whole repo). Anything else
// stays "main_moved", today's answer, and main is untouched.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alwaysRetest, carryVerdict } from "../src/merge-carry.js";
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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function origin() {
  const bare = tmp("bm-origin-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("bm-seed-");
  git(seed, "clone", "-q", bare, ".");
  writeFileSync(path.join(seed, "app.txt"), "line 1\nline 2\nline 3\n");
  writeFileSync(path.join(seed, "package.json"), "{}\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  /** One commit on main changing these files, pushed to `ref` (main by default). */
  const pushChange = (files: Record<string, string>, ref = "main") => {
    git(seed, "fetch", "-q", "origin", "main");
    git(seed, "reset", "-q", "--hard", "origin/main");
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      writeFileSync(path.join(seed, file), content);
    }
    git(seed, "add", ".");
    git(seed, "commit", "-qm", `edit ${Object.keys(files).join(", ")}`);
    git(seed, "push", "-q", "origin", `HEAD:${ref}`);
  };
  return { url: bare, pushChange, mainSha: () => git(bare, "rev-parse", "main") };
}

const project = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function ticket(o: ReturnType<typeof origin>, files: Record<string, string>) {
  const ws = new Workspaces(tmp("bm-ws-root-"));
  const spec = { projectId: project, ticketId: A, repoUrl: o.url, baseRef: "main" };
  const w = await ws.ensure(spec);
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(w.path, file), content);
  git(w.path, "add", ".");
  git(w.path, "commit", "-qm", "ticket work");
  return { ws, spec, dir: w.path };
}

type Prepared = { status: "prepared"; commit: string; tree: string; targetSha: string; branchSha: string };

describe("carry a passed merge across a main move (BOS-1762)", () => {
  it("lands on the moved main when main's new commits touch none of the ticket's files", async () => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "mine.txt": "mine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    const base = o.mainSha();
    o.pushChange({ "theirs.txt": "theirs\n" });
    o.pushChange({ "docs/other.md": "more\n" });
    const moved = o.mainSha();
    const r = await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree, carry: true });
    expect(r).toMatchObject({ status: "merged", checked: { sha: p.commit, tree: p.tree }, carried: { from: base, to: moved, commits: 2, files: 2 } });
    // The landed commit is the merge of the ticket's branch on the new main: parents new main and the tested branch head.
    expect(git(o.url, "rev-parse", "main^1")).toBe(moved);
    expect(git(o.url, "rev-parse", "main^2")).toBe(p.branchSha);
    expect(git(o.url, "show", "main:mine.txt")).toBe("mine");
    expect(git(o.url, "show", "main:theirs.txt")).toBe("theirs");
    // The tree differs from the tested one only in main's files.
    expect(git(o.url, "diff", "--name-only", p.tree, "main^{tree}").split("\n").sort()).toEqual(["docs/other.md", "theirs.txt"]);
  });

  it("re-tests (main_moved, nothing pushed) when main touched a file the ticket changes", async () => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "app.txt": "line 1\nline 2\nline 3\nmine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange({ "app.txt": "theirs\nline 2\nline 3\n" });
    const moved = o.mainSha();
    const r = await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree, carry: true });
    expect(r).toEqual({ status: "main_moved", notCarried: { why: "main changed files this ticket changes", files: ["app.txt"] } });
    expect(o.mainSha()).toBe(moved);
  });

  it.each([
    ["a package manifest", { "package.json": '{"x":1}\n' }, "package.json"],
    ["a lockfile", { "pnpm-lock.yaml": "lockfileVersion: 9\n" }, "pnpm-lock.yaml"],
    ["a CI workflow", { ".github/workflows/ci.yml": "on: push\n" }, ".github/workflows/ci.yml"],
    ["a migration", { "apps/server/drizzle/0001_x.sql": "select 1;\n" }, "apps/server/drizzle/0001_x.sql"],
  ])("re-tests when main changed %s, though the ticket's files are untouched", async (_what, change, file) => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "mine.txt": "mine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange(change);
    const moved = o.mainSha();
    const r = await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree, carry: true });
    expect(r).toEqual({ status: "main_moved", notCarried: { why: "main changed dependencies, build, CI or migration files", files: [file] } });
    expect(o.mainSha()).toBe(moved);
  });

  it("without carry, a disjoint move is still main_moved (today's behaviour, and what an old server sends)", async () => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "mine.txt": "mine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange({ "theirs.txt": "theirs\n" });
    const moved = o.mainSha();
    expect(await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree })).toEqual({ status: "main_moved" });
    expect(o.mainSha()).toBe(moved);
  });

  it("never carries a branch that changed after the tested merge was built", async () => {
    const o = origin();
    const { ws, spec, dir } = await ticket(o, { "mine.txt": "mine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    writeFileSync(path.join(dir, "late.txt"), "untested\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "late commit");
    o.pushChange({ "theirs.txt": "theirs\n" });
    const moved = o.mainSha();
    const r = await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree, carry: true });
    expect(r).toEqual({ status: "main_moved", notCarried: { why: "the branch is not the one that was tested" } });
    expect(o.mainSha()).toBe(moved);
  });

  it("a push that loses a race to another landing says carryEligible, and the next finish lands on the newer tip", async () => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "mine.txt": "mine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange({ "theirs.txt": "theirs\n" });
    // The racing landing waits on a side branch; origin's hook moves main to it and refuses the first push to main.
    o.pushChange({ "race.txt": "race\n" }, "race");
    const hook = path.join(o.url, "hooks", "pre-receive");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        'if [ -f "$GIT_DIR/raced" ]; then exit 0; fi',
        'touch "$GIT_DIR/raced"',
        // Ref updates are refused inside the push's object quarantine; the race commit is already stored, so leave it.
        "env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git update-ref refs/heads/main refs/heads/race",
        "echo 'raced' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const race = git(o.url, "rev-parse", "race");
    const first = await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree, carry: true });
    expect(first).toEqual({ status: "main_moved", carryEligible: true });
    expect(o.mainSha()).toBe(race);
    const second = await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree, carry: true });
    expect(second).toMatchObject({ status: "merged", carried: { to: race } });
    expect(git(o.url, "rev-parse", "main^1")).toBe(race);
    expect(git(o.url, "show", "main:race.txt")).toBe("race");
  });
});

// BOS-1820: prepare with carryFrom (the merge a queued check still waits on) says whether that merge's pass could be carried
// onto the fresh one, by the same rule as finish. The keep ref (which "publish" insists on) moves only on a refusal, the one
// case the gate switches the job to the new merge.
describe("prepare's carry answer for a queued merge (BOS-1820)", () => {
  const kept = (dir: string) => git(dir, "rev-parse", `refs/bossman/merge/${A}`);
  const repoOf = (ws: Workspaces) => (ws as unknown as { repoDir(id: string): string }).repoDir(project);

  it("main changed a check script: carry refused, naming the file, and the new merge is kept", async () => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "mine.txt": "mine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange({ "scripts/check-test-lines.mjs": "// new rule\n" });
    const r = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare", carryFrom: { commit: p.commit, tree: p.tree } })) as Prepared & { carry?: unknown };
    expect(r.status).toBe("prepared");
    expect(r.tree).not.toBe(p.tree);
    expect(r.carry).toEqual({ ok: false, why: "main changed dependencies, build, CI or migration files", files: ["scripts/check-test-lines.mjs"] });
    expect(kept(repoOf(ws))).toBe(r.commit);
  });

  it("a file-disjoint main move: carry ok, and the queued merge stays the kept one", async () => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "mine.txt": "mine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange({ "theirs.txt": "theirs\n" });
    const r = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare", carryFrom: { commit: p.commit, tree: p.tree } })) as Prepared & { carry?: unknown };
    expect(r.tree).not.toBe(p.tree);
    expect(r.carry).toEqual({ ok: true });
    expect(kept(repoOf(ws))).toBe(p.commit);
  });

  it("main unmoved: no carry answer, nothing to decide; without carryFrom the answer is today's", async () => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "mine.txt": "mine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    const same = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare", carryFrom: { commit: p.commit, tree: p.tree } })) as Prepared & { carry?: unknown };
    expect(same.tree).toBe(p.tree);
    expect(same.carry).toBeUndefined();
    o.pushChange({ "scripts/check-x.sh": "true\n" });
    const plain = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared & { carry?: unknown };
    expect(plain.carry).toBeUndefined();
    expect(kept(repoOf(ws))).toBe(plain.commit);
  });
});

describe("carryVerdict (BOS-1762)", () => {
  it("is ok only for disjoint files, no whole-repo files, and drift inside main's files", () => {
    expect(carryVerdict({ mine: ["a.ts"], theirs: ["b.ts"], drift: ["b.ts"] })).toEqual({ ok: true });
    expect(carryVerdict({ mine: ["a.ts", "c.ts"], theirs: ["c.ts", "b.ts"], drift: [] })).toMatchObject({ ok: false, files: ["c.ts"] });
    expect(carryVerdict({ mine: ["a.ts"], theirs: ["b.ts"], drift: ["b.ts", "a.ts"] })).toMatchObject({ ok: false, files: ["a.ts"] });
  });

  it("names the whole-repo paths generically, at any depth", () => {
    for (const p of ["package.json", "apps/web/package.json", "yarn.lock", "go.sum", "Cargo.lock", "poetry.lock", "pnpm-workspace.yaml", "apps/server/tsconfig.build.json", "apps/web/vite.config.ts", "vitest.config.mts", ".github/workflows/ci.yml", "apps/runner/Dockerfile", "scripts/check-all.sh", "db/migrations/001.sql", "apps/server/drizzle/meta/_journal.json"]) {
      expect(alwaysRetest(p), p).toBe(true);
    }
    for (const p of ["apps/server/src/app.ts", "README.md", "docs/package.json.md", "scripts/deploy.sh", "src/migrationsHelper.ts"]) {
      expect(alwaysRetest(p), p).toBe(false);
    }
  });
});
