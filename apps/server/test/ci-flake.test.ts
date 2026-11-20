// BOS-1733 (CI fix 2): the pure parts of "a GitHub failure in a test the branch didn't touch": which tests the failure names,
// which names are safe to put in a shell command, the ordered decision table, and the gate's re-run command, run here with a
// real `sh` in a made-up repo whose pnpm and vitest are stubs.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CANT_RERUN_EXIT,
  flakeDecision,
  gateRerunCommand,
  GATE_RERUN_MARK,
  MAX_FLAKY_FILES,
  MIN_BASELINE_RUNS,
  namedTestFiles,
  repoRelative,
  RETRIES_PER_WEEK,
  retryCounts,
  SAFE_TEST_PATH,
  SLOW_RETRIES_PER_WEEK,
  slowJobs,
  slowRetryCounts,
  type FlakeFacts,
  type SlowEvidence,
} from "../src/services/ci-flake.js";
import { GATE_RERUN_COLOURED, JSON_PASSED, OLD_PASS_GREP } from "./fixtures/vitest-gate-output.js";

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

describe("BOS-2082: a slow GitHub machine gets one retry, whatever the file count", () => {
  // BOS-2066's run 44731483832: the web-browser step took 698 s; the other runs that day took 209 to 343 s.
  const TODAY = [211, 343, 209, 260, 298, 275, 240, 330];
  const web = (over: Partial<SlowEvidence> = {}): SlowEvidence => ({ job: "web-browser", step: "Web tests in a real browser", seconds: 698, baseline: TODAY, timeoutsOnly: true, ...over });
  const fourFiles = { files: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"], unnamed: [], unsafe: [] };
  const facts = (slow: ReturnType<typeof slowJobs>, over: Partial<FlakeFacts> = {}): FlakeFacts => ({ billing: false, slow, slowRecent: new Map(), named: fourFiles, changed: ["docs/x.md"], mainRed: false, retriedThisCommit: false, recent: new Map(), ...over });

  it("698 s against 209-343 s, all timeouts, 4 files: retried once on GitHub, with why", () => {
    const slow = slowJobs([web()]);
    expect(slow).toEqual([{ job: "web-browser", step: "Web tests in a real browser", seconds: 698, median: 268, runs: 8 }]);
    expect(flakeDecision(facts(slow))).toEqual({ act: "retry_slow", jobs: slow });
    // Without the slow row the same failure bounces as "more than a one-off", as it did on 20 Nov.
    expect(flakeDecision(facts(null))).toMatchObject({ act: "bounce", why: "4 test files failed, more than a one-off" });
  });

  it.each([
    ["a normal time (300 s) with 4 timeouts", web({ seconds: 300 })],
    ["a failure that isn't a timeout", web({ timeoutsOnly: false })],
    ["too few green runs to know the usual time", web({ baseline: TODAY.slice(0, MIN_BASELINE_RUNS - 1) })],
    ["no step time from GitHub", web({ seconds: null })],
    ["no failed step named", web({ step: null })],
  ])("not a slow machine: %s", (_name, ev) => {
    expect(slowJobs([ev])).toBeNull();
    expect(flakeDecision(facts(slowJobs([ev]))).act).toBe("bounce");
  });

  it("every failed job must be slow: one normal job beside a slow one is no slow machine", () => {
    expect(slowJobs([web(), web({ job: "check", step: "Tests", seconds: 1000, baseline: [906, 1100, 1447] })])).toBeNull();
    expect(slowJobs([])).toBeNull();
  });

  it.each([
    ["main is red", { mainRed: true }, /main is red/],
    ["this commit already had its retry", { retriedThisCommit: true }, /already had its one GitHub retry/],
    ["the job's weekly slow-machine budget is spent", { slowRecent: new Map([["web-browser", SLOW_RETRIES_PER_WEEK]]) }, /has had 5 slow-machine retries in 7 days/],
    ["billing (outranks the slow row)", { billing: true }, /billing/],
  ] as const)("a slow machine still bounces when %s", (_name, over, why) => {
    const d = flakeDecision(facts(slowJobs([web()]), over as Partial<FlakeFacts>));
    expect(d).toMatchObject({ act: "bounce", why: expect.stringMatching(why) });
  });

  it("slowRetryCounts counts slow-machine rows per job and leaves file rows to retryCounts", () => {
    const rows = ["slow machine: web-browser", "slow machine: web-browser\nslow machine: check", "apps/server/test/a.test.ts", null];
    expect([...slowRetryCounts(rows).entries()].sort()).toEqual([["check", 1], ["web-browser", 2]]);
    expect([...retryCounts(rows).entries()]).toEqual([["apps/server/test/a.test.ts", 1]]);
  });
});

describe("gateRerunCommand, run by a real sh", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bos1733-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "stub-bin");
  mkdirSync(bin);
  // A pnpm that installs nothing; a vitest that answers from the test file's text, printing where it ran. BOS-2082: on a pass
  // it prints the real coloured output of BOS-1986's gate re-run and writes vitest's real JSON report where it was asked to.
  writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\necho stub pnpm \"$@\"\n");
  chmodSync(path.join(bin, "pnpm"), 0o755);
  const fix = path.join(root, "fixtures");
  mkdirSync(fix);
  writeFileSync(path.join(fix, "coloured.txt"), GATE_RERUN_COLOURED);
  writeFileSync(path.join(fix, "pass.json"), JSON.stringify(JSON_PASSED));
  writeFileSync(path.join(fix, "skip.json"), JSON.stringify({ ...JSON_PASSED, numPassedTests: 0, numPendingTests: 3, numTotalTests: 3 }));
  writeFileSync(path.join(fix, "fail.json"), JSON.stringify({ ...JSON_PASSED, numPassedTests: 2, numFailedTests: 1, success: false }));
  // Passed per vitest's exit code, but the report says a test failed: never a pass.
  writeFileSync(path.join(fix, "liar.json"), JSON.stringify({ ...JSON_PASSED, numFailedTests: 1, success: false }));
  const vitest = [
    "#!/bin/sh",
    'echo "vitest ran in $PWD on $2 NO_COLOR=${NO_COLOR:-unset}"',
    'json=""; for a in "$@"; do case "$a" in --outputFile.json=*) json=${a#--outputFile.json=};; esac; done',
    'if [ ! -f "$2" ]; then echo "No test files found, exiting with code 1"; exit 1; fi',
    `if grep -q FAIL "$2"; then echo " Tests  1 failed | 2 passed (3)"; cp '${fix}/fail.json' "$json"; exit 1; fi`,
    `if grep -q SKIP "$2"; then echo " Tests  3 skipped (3)"; cp '${fix}/skip.json' "$json"; exit 0; fi`,
    `cat '${fix}/coloured.txt'`,
    'if grep -q NOJSON "$2"; then exit 0; fi',
    `if grep -q BADJSON "$2"; then echo "{not json" > "$json"; exit 0; fi`,
    `if grep -q LIAR "$2"; then cp '${fix}/liar.json' "$json"; exit 0; fi`,
    `cp '${fix}/pass.json' "$json"`,
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

  it("BOS-2082: vitest's real coloured output (BOS-1986's 59 passed) with its JSON report is a pass, read from the JSON", () => {
    // The fixture really is the line BOS-1733's grep missed: it misses it coloured and finds it once the colour is gone.
    expect(GATE_RERUN_COLOURED).toContain("\x1b[");
    expect(OLD_PASS_GREP.test(GATE_RERUN_COLOURED)).toBe(false);
    expect(OLD_PASS_GREP.test(GATE_RERUN_COLOURED.replace(/\x1b\[[0-9;]*m/g, ""))).toBe(true);
    const r = sh(repo({ "apps/server/test/a.test.ts": "ok" }), ["apps/server/test/a.test.ts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("NO_COLOR=1");
    expect(r.out).toContain("boss-man re-run: apps/server/test/a.test.ts: 23 passed (vitest JSON result)");
    expect(r.out).toContain("boss-man re-run: passed");
  });

  it("BOS-2082: the JSON result decides, never the terminal text: a report saying a test failed is no pass", () => {
    const r = sh(repo({ "apps/server/test/a.test.ts": "LIAR" }), ["apps/server/test/a.test.ts"]);
    expect(r.code).toBe(CANT_RERUN_EXIT);
    expect(r.out).toMatch(/no test in .* passed/);
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
    ["vitest wrote no JSON report (BOS-2082)", { "apps/server/test/a.test.ts": "NOJSON" }, {}, /vitest wrote no JSON result/],
    ["vitest's JSON report is unreadable (BOS-2082)", { "apps/server/test/a.test.ts": "BADJSON" }, {}, /JSON result for .* is unreadable/],
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
