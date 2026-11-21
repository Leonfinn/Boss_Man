// BOS-1762, runner side, against a real bare "origin": finish with `carry` lands a passed merge on a main that moved since
// prepare when main's new commits touch none of the ticket's files (and nothing that re-tests the whole repo). Anything else
// stays "main_moved", today's answer, and main is untouched.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { alwaysRetest, carryVerdict, nameList, retestFiles } from "../src/merge-carry.js";
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
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(w.path, file)), { recursive: true });
    writeFileSync(path.join(w.path, file), content);
  }
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
    ["a package manifest", { "package.json": '{"x":1}\n' }, "package.json", "dependencies"],
    ["a lockfile", { "pnpm-lock.yaml": "lockfileVersion: 9\n" }, "pnpm-lock.yaml", "dependencies"],
    ["a check script", { "scripts/check-test-lines.mjs": "// new rule\n" }, "scripts/check-test-lines.mjs", "check scripts"],
  ])("re-tests when main changed %s, though the ticket's files are untouched", async (_what, change, file, what) => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "mine.txt": "mine\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange(change);
    const moved = o.mainSha();
    const r = await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree, carry: true });
    expect(r).toEqual({ status: "main_moved", notCarried: { why: `main changed ${what}`, files: [file] } });
    expect(o.mainSha()).toBe(moved);
  });

  // BOS-1925: main's migration, CI workflow or another package's build config no longer re-tests a merge that touches none
  // of them (each was a forced re-check before: 17 of the 35 in the 24 h to 19 Nov 15:30).
  it.each([
    ["a migration", { "apps/server/drizzle/0001_x.sql": "select 1;\n", "apps/server/drizzle/meta/_journal.json": "{}\n" }],
    ["a CI workflow", { ".github/workflows/ci.yml": "on: push\n" }],
    ["another package's build config", { "apps/web/vite.config.ts": "export default {};\n" }],
  ])("carries when main changed %s that the ticket doesn't touch", async (_what, change) => {
    const o = origin();
    // Server code only: a file at the root would re-test on another package's config (it may be built by it).
    const { ws, spec } = await ticket(o, { "apps/server/src/mine.ts": "export {};\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange(change);
    const moved = o.mainSha();
    const r = await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree, carry: true });
    expect(r).toMatchObject({ status: "merged", carried: { to: moved } });
    expect(git(o.url, "rev-parse", "main^1")).toBe(moved);
  });

  it("re-tests when main and the ticket both add a migration in the same folder (different files, no journal)", async () => {
    const o = origin();
    const { ws, spec } = await ticket(o, { "db/migrations/002_mine.sql": "select 2;\n" });
    const p = (await ws.merge(spec, "main", "Merge A", {}, null, { phase: "prepare" })) as Prepared;
    o.pushChange({ "db/migrations/002_theirs.sql": "select 3;\n" });
    const moved = o.mainSha();
    const r = await ws.merge(spec, "main", "Merge A", {}, null, { phase: "finish", commit: p.commit, tree: p.tree, carry: true });
    expect(r).toEqual({ status: "main_moved", notCarried: { why: "main changed migrations (this ticket changes them too)", files: ["db/migrations/002_theirs.sql"] } });
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
    expect(r.carry).toEqual({ ok: false, why: "main changed check scripts", files: ["scripts/check-test-lines.mjs"] });
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
    for (const p of ["package.json", "apps/web/package.json", "yarn.lock", "go.sum", "Cargo.lock", "poetry.lock", "pnpm-workspace.yaml", "vitest.config.mts", "tsconfig.base.json", "web/vite.config.ts", "apps/runner/Dockerfile", "docker-compose.yml", "scripts/check-all.sh"]) {
      expect(alwaysRetest(p), p).toBe(true);
    }
    // BOS-1925: migrations, CI and a package's own config are no longer whole-repo (see retestFiles).
    for (const p of ["apps/server/src/app.ts", "README.md", "docs/package.json.md", "scripts/deploy.sh", "src/migrationsHelper.ts", "apps/server/tsconfig.build.json", "apps/web/vite.config.ts", ".github/workflows/ci.yml", "db/migrations/001.sql", "apps/server/drizzle/meta/_journal.json"]) {
      expect(alwaysRetest(p), p).toBe(false);
    }
  });
});

describe("nameList: git diff --name-only -z output to paths (BOS-2133)", () => {
  it("is empty for no names, with or without git's trailing NUL", () => {
    expect(nameList("")).toEqual([]);
    expect(nameList("\0")).toEqual([]);
  });

  it("gives one name back", () => {
    expect(nameList("src/one.ts\0")).toEqual(["src/one.ts"]);
  });

  it("gives two names back in the order git listed them", () => {
    expect(nameList("src/one.ts\0src/two.ts\0")).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("keeps every name and applies no cut-off, however many there are", () => {
    const names = Array.from({ length: 200 }, (_, i) => `packages/example/src/file-${i}.ts`);
    const oneLongName = `${"deep/".repeat(40)}last.txt`;
    const all = [...names, oneLongName];
    expect(nameList(all.map((n) => `${n}\0`).join(""))).toEqual(all);
  });

  it("keeps names with spaces and drops only empty pieces", () => {
    expect(nameList("a folder/one file.ts\0\0two.ts\0")).toEqual(["a folder/one file.ts", "two.ts"]);
  });
});

// BOS-1925: the decision table, one row per scope. Each "carries" row re-tested on the code before BOS-1925.
describe("retestFiles: which of main's files re-test this merge (BOS-1925)", () => {
  const SERVER = ["apps/server/src/review.ts", "apps/server/test/review.test.ts"];
  const MIGRATION = ["apps/server/drizzle/0172_run_cost_check.sql", "apps/server/drizzle/meta/0172_snapshot.json", "apps/server/drizzle/meta/_journal.json"];

  it.each<[string, string[], string[], string[]]>([
    // [row, mine, theirs, files that re-test]
    ["migration on main, merge has none", SERVER, MIGRATION, []],
    ["migration on main, merge carries one in the same folder", [...SERVER, "apps/server/drizzle/0172_mine.sql"], MIGRATION, MIGRATION],
    ["migration in another folder", ["db/migrations/001.sql"], MIGRATION, []],
    ["CI workflow on main, merge has none", SERVER, [".github/workflows/ci.yml"], []],
    ["CI workflow on main, merge changes CI too", [...SERVER, ".github/workflows/release.yml"], [".github/workflows/ci.yml"], [".github/workflows/ci.yml"]],
    ["web's config, server-only merge", SERVER, ["apps/web/vite.config.ts"], []],
    ["web's config, merge touches web", [...SERVER, "apps/web/src/App.tsx"], ["apps/web/vite.config.ts"], ["apps/web/vite.config.ts"]],
    ["web's config, merge touches shared code", ["packages/shared/src/risk.ts"], ["apps/web/vite.config.ts"], ["apps/web/vite.config.ts"]],
    ["web's config, merge touches a root file", ["README.md"], ["apps/web/vite.config.ts"], ["apps/web/vite.config.ts"]],
    ["web's config, merge touches a file beside the packages", ["apps/README.md"], ["apps/web/vite.config.ts"], ["apps/web/vite.config.ts"]],
    ["server's tsconfig, web-only merge", ["apps/web/src/App.tsx"], ["apps/server/tsconfig.json"], []],
    ["config one folder deep stays global", SERVER, ["web/vite.config.ts"], ["web/vite.config.ts"]],
    ["root config stays global", SERVER, ["tsconfig.base.json"], ["tsconfig.base.json"]],
    ["lockfile stays global", SERVER, ["pnpm-lock.yaml"], ["pnpm-lock.yaml"]],
    ["check script stays global", SERVER, ["scripts/check-quick.sh", "scripts/check-quick.test.sh"], ["scripts/check-quick.sh", "scripts/check-quick.test.sh"]],
    ["compose stays global", SERVER, ["docker-compose.yml"], ["docker-compose.yml"]],
    // The 18 Nov 21:49 burst: ci.yml + migration 0171 + the ratchet. The ratchet alone still re-tests.
    ["ci.yml + migration + check script", SERVER, [".github/workflows/ci.yml", ...MIGRATION, "scripts/check-test-lines.mjs"], ["scripts/check-test-lines.mjs"]],
  ])("%s", (_row, mine, theirs, want) => {
    expect(retestFiles(mine, theirs).files).toEqual([...want].sort());
    const v = carryVerdict({ mine, theirs, drift: theirs });
    expect(v.ok).toBe(want.length === 0);
  });

  it("says which rules re-test, so the merge-line record names them", () => {
    expect(carryVerdict({ mine: ["apps/server/drizzle/0002_a.sql"], theirs: ["apps/server/drizzle/0001_b.sql", "pnpm-lock.yaml"], drift: [] })).toEqual({
      ok: false,
      why: "main changed migrations (this ticket changes them too), dependencies",
      files: ["apps/server/drizzle/0001_b.sql", "pnpm-lock.yaml"],
    });
  });
});
