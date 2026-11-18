// BOS-1733 (CI fix 2): the pure parts of "a GitHub failure in a test the branch didn't touch": which tests the failure names,
// which names are safe to put in a shell command, the ordered decision table, and the gate's re-run command, run here with a
// real `sh` in a made-up repo whose pnpm and vitest are stubs.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CANT_RERUN_EXIT, flakeDecision, gateRerunCommand, GATE_RERUN_MARK, MAX_FLAKY_FILES, namedTestFiles, repoRelative, RETRIES_PER_WEEK, retryCounts, SAFE_TEST_PATH, type FlakeFacts } from "../src/services/ci-flake.js";

describe("namedTestFiles", () => {
  it("takes repo-relative test paths from the failure annotations, sorted and unique", () => {
    const n = namedTestFiles([
      { job: "check", paths: ["apps/server/test/b.test.ts", "apps/server/test/a.test.ts"] },
      { job: "check (2)", paths: ["apps/server/test/a.test.ts"] },
    ]);
    expect(n).toEqual({ files: ["apps/server/test/a.test.ts", "apps/server/test/b.test.ts"], unnamed: [], unsafe: [] });
  });

  it("cuts a GitHub workspace prefix back to the repo-relative path", () => {
    expect(repoRelative("/home/runner/work/site/site/apps/x.test.ts")).toBe("apps/x.test.ts");
    expect(repoRelative("/__w/site/site/apps/x.test.ts")).toBe("apps/x.test.ts");
    expect(repoRelative("/srv/actions/_work/site/site/apps/x.test.ts")).toBe("apps/x.test.ts");
    expect(repoRelative("/github/workspace/apps/x.test.ts")).toBe("apps/x.test.ts");
    expect(repoRelative("/etc/x.test.ts")).toBe("/etc/x.test.ts");
    expect(namedTestFiles([{ job: "check", paths: ["/home/runner/work/site/site/apps/x.test.ts"] }]).files).toEqual(["apps/x.test.ts"]);
  });

  it("a job with unreadable annotations, none, or one on a source file makes the failure unnamed", () => {
    expect(namedTestFiles([{ job: "check", paths: null }]).unnamed).toEqual(["check"]);
    expect(namedTestFiles([{ job: "check", paths: [] }]).unnamed).toEqual(["check"]);
    expect(namedTestFiles([{ job: "check", paths: ["apps/x.test.ts", "apps/src/x.ts"] }]).unnamed).toEqual(["check"]);
    // A job-level note with no file (GitHub's "Process completed") is dropped by failures(), shown here as an empty path.
    expect(namedTestFiles([{ job: "check", paths: [""] }]).unnamed).toEqual(["check"]);
  });

  it("refuses hostile names: they never reach a shell", () => {
    for (const bad of ["$(id).test.ts", "a b.test.ts", "../x.test.ts", "a/../../x.test.ts", "/etc/x.test.ts", "x'y.test.ts", 'x"y.test.ts', "x;rm.test.ts", "x`id`.test.ts", "-rf.test.ts", "x\\y.test.ts"]) {
      expect(SAFE_TEST_PATH.test(bad), bad).toBe(false);
      const n = namedTestFiles([{ job: "check", paths: [bad] }]);
      expect(n.files, bad).toEqual([]);
      expect(n.unnamed, bad).toEqual(["check"]);
      expect(() => gateRerunCommand([bad])).toThrow(/unsafe test path/);
    }
    expect(namedTestFiles([{ job: "check", paths: ["$(id).test.ts"] }]).unsafe).toEqual(["$(id).test.ts"]);
    for (const good of ["apps/server/test/a.test.ts", "packages/@scope/x.spec.tsx", "a_b-c.test.mjs"]) expect(SAFE_TEST_PATH.test(good), good).toBe(true);
  });
});

describe("flakeDecision: the ordered table, first refusal wins", () => {
  const facts = (over: Partial<FlakeFacts> = {}): FlakeFacts => ({
    billing: false,
    named: { files: ["apps/server/test/a.test.ts"], unnamed: [], unsafe: [] },
    changed: ["apps/server/src/a.ts"],
    mainRed: false,
    retriedThisCommit: false,
    recent: new Map(),
    ...over,
  });

  it("re-runs at the gate when every row passes", () => {
    expect(flakeDecision(facts())).toEqual({ act: "rerun_at_gate", files: ["apps/server/test/a.test.ts"] });
  });

  it.each([
    ["billing", { billing: true }, /billing/],
    ["an unsafe name", { named: { files: [], unnamed: ["check"], unsafe: ["$(id).test.ts"] } }, /won't run/],
    ["an unnamed job", { named: { files: ["a.test.ts"], unnamed: ["images (arm64)"], unsafe: [] } }, /images \(arm64\) doesn't name a test file/],
    ["too many files", { named: { files: Array.from({ length: MAX_FLAKY_FILES + 1 }, (_, i) => `t${i}.test.ts`), unnamed: [], unsafe: [] } }, /more than a one-off/],
    ["an unreadable diff", { changed: null }, /couldn't read which files/],
    ["a file the branch changes", { changed: ["apps/server/test/a.test.ts"] }, /the branch changes apps\/server\/test\/a\.test\.ts/],
    ["main is red", { mainRed: true }, /main is red/],
    ["this commit already retried", { retriedThisCommit: true }, /already had its one GitHub retry/],
    ["the weekly cap", { recent: new Map([["apps/server/test/a.test.ts", RETRIES_PER_WEEK]]) }, /no more retries for it until it is fixed/],
  ] as const)("bounces on %s", (_name, over, why) => {
    const d = flakeDecision(facts(over as Partial<FlakeFacts>));
    expect(d.act).toBe("bounce");
    expect(d.act === "bounce" && d.why).toMatch(why);
  });

  it("billing outranks everything after it (order holds)", () => {
    expect(flakeDecision(facts({ billing: true, mainRed: true, changed: null }))).toMatchObject({ why: expect.stringMatching(/billing/) });
    expect(flakeDecision(facts({ changed: ["apps/server/test/a.test.ts"], mainRed: true }))).toMatchObject({ why: expect.stringMatching(/branch changes/) });
  });

  it("retryCounts counts each file once per recorded retry and ignores junk lines", () => {
    const c = retryCounts(["a.test.ts\nb.test.ts", "a.test.ts\na.test.ts", null, "$(id).test.ts"]);
    expect([...c.entries()].sort()).toEqual([["a.test.ts", 2], ["b.test.ts", 1]]);
  });
});

describe("gateRerunCommand, run by a real sh", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bos1733-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "stub-bin");
  mkdirSync(bin);
  // A pnpm that installs nothing; a vitest that answers from the test file's text, printing where it ran.
  writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\necho stub pnpm \"$@\"\n");
  chmodSync(path.join(bin, "pnpm"), 0o755);
  const vitest = [
    "#!/bin/sh",
    'echo "vitest ran in $PWD on $2"',
    'if [ ! -f "$2" ]; then echo "No test files found, exiting with code 1"; exit 1; fi',
    'if grep -q FAIL "$2"; then echo " Tests  1 failed | 2 passed (3)"; exit 1; fi',
    'if grep -q SKIP "$2"; then echo " Tests  3 skipped (3)"; exit 0; fi',
    'echo " Tests  3 passed (3)"',
  ].join("\n");

  let n = 0;
  /** A made-up repo: a lockfile (or none), a nested package with vitest, and the given test files. */
  const repo = (files: Record<string, string>, opts: { lock?: boolean; vitest?: boolean } = {}) => {
    const dir = path.join(root, `repo${n++}`);
    mkdirSync(path.join(dir, "apps/server/test"), { recursive: true });
    if (opts.lock !== false) writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, "apps/server/package.json"), "{}");
    if (opts.vitest !== false) {
      mkdirSync(path.join(dir, "apps/server/node_modules/.bin"), { recursive: true });
      writeFileSync(path.join(dir, "apps/server/node_modules/.bin/vitest"), vitest);
      chmodSync(path.join(dir, "apps/server/node_modules/.bin/vitest"), 0o755);
    }
    for (const [f, text] of Object.entries(files)) writeFileSync(path.join(dir, f), text);
    return dir;
  };
  const sh = (dir: string, files: string[]) => {
    const r = spawnSync("sh", ["-c", gateRerunCommand(files)], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("starts with its mark and runs each file from its nearest package, by its path inside it: pass is 0", () => {
    const dir = repo({ "apps/server/test/a.test.ts": "ok", "apps/server/test/b.test.ts": "ok" });
    expect(gateRerunCommand(["apps/server/test/a.test.ts"]).split("\n")[0]).toBe(GATE_RERUN_MARK);
    const r = sh(dir, ["apps/server/test/a.test.ts", "apps/server/test/b.test.ts"]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain("stub pnpm install --frozen-lockfile --prefer-offline");
    expect(r.out).toContain(`vitest ran in ${path.join(dir, "apps/server")} on test/a.test.ts`);
    expect(r.out).toContain("on test/b.test.ts");
    expect(r.out).toContain("boss-man re-run: passed");
  });

  it("a failing test is exit 1 (a real failure), never 78", () => {
    const r = sh(repo({ "apps/server/test/a.test.ts": "FAIL" }), ["apps/server/test/a.test.ts"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("1 failed");
  });

  it.each([
    ["the file isn't in the merge commit", {}, {}, /is not in the merge commit/],
    ["there is no vitest", { "apps/server/test/a.test.ts": "ok" }, { vitest: false }, /no vitest for/],
    ["there is no lockfile", { "apps/server/test/a.test.ts": "ok" }, { lock: false }, /no pnpm-lock\.yaml or package-lock\.json/],
    ["every test was skipped (no browser here, say)", { "apps/server/test/a.test.ts": "SKIP" }, {}, /no test in .* passed/],
  ] as const)("can't re-run (exit 78) when %s: never read as a pass", (_name, files, opts, said) => {
    const r = sh(repo(files as Record<string, string>, opts), ["apps/server/test/a.test.ts"]);
    expect(r.code).toBe(CANT_RERUN_EXIT);
    expect(r.out).toMatch(said);
  });

  it("a test file at the repo root's package runs by its own path", () => {
    const dir = repo({});
    mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules/.bin/vitest"), vitest);
    chmodSync(path.join(dir, "node_modules/.bin/vitest"), 0o755);
    mkdirSync(path.join(dir, "test"));
    writeFileSync(path.join(dir, "test/root.test.ts"), "ok");
    const r = sh(dir, ["test/root.test.ts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`vitest ran in ${dir} on test/root.test.ts`);
  });
});
