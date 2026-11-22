// BOS-1721 (fix 1 of BOS-1720): every GitHub test step must leave the failing test's name where Boss Man can read it.
// Boss Man reads a bounced merge copy's failure from GitHub's public check-run annotations (services/git-hosts.ts);
// the raw job log needs a sign-in. vitest prints "::error file=…,title=<test>" for each failure, but GitHub makes an
// annotation of a line only when it starts with "::", and `pnpm -r` puts "apps/<pkg> test: " in front of every line.
// In BOS-1720's sweep 52 of 52 failed `check` test steps named no test for that reason.
// The workflow is parsed as YAML and each step's own `run` is checked, so moving or rewording lines can't fool it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; run?: string; if?: string };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const ciYml = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");

/** Every `pnpm -r … test` command in a step's run script (pnpm's own flags sit between -r and the script name). */
function recursiveTestCommands(run: string): string[] {
  return run
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .flatMap((l) => l.match(/pnpm -r(?: --[\w-]+)* test\b/g) ?? []);
}

/** The faults that would leave a failing GitHub test unnamed, for one parsed workflow. */
function unnamedTestSteps(wf: Workflow): string[] {
  const faults: string[] = [];
  for (const [job, { steps = [] }] of Object.entries(wf.jobs)) {
    for (const [i, step] of steps.entries()) {
      const where = `${job} step ${i + 1}${step.name ? ` (${step.name})` : ""}`;
      for (const cmd of recursiveTestCommands(step.run ?? "")) {
        if (!/ --reporter-hide-prefix\b/.test(cmd)) faults.push(`${where}: "${cmd}" lacks --reporter-hide-prefix, so vitest's ::error lines are prefixed and GitHub ignores them`);
      }
      // A *.test.sh run bare leaves only "exit code 1"; scripts/test-shell.sh names the file and its last lines.
      for (const line of (step.run ?? "").split("\n")) {
        if (/^\s*#/.test(line)) continue;
        if (/scripts\/[\w.-]+\.test\.sh\b/.test(line) && !/scripts\/test-shell\.sh\b/.test(line)) faults.push(`${where}: "${line.trim()}" runs a shell test bare; run it through scripts/test-shell.sh so the failure is named`);
      }
    }
  }
  return faults;
}

describe("GitHub CI names every failing test (BOS-1721)", () => {
  const wf = parse(ciYml) as Workflow;

  it("ci.yml has no test step that would fail unnamed", () => {
    expect(unnamedTestSteps(wf)).toEqual([]);
  });

  it("the check job's unit-test step still runs pnpm -r test, with the flag, after a failed typecheck", () => {
    const steps = wf.jobs.check?.steps ?? [];
    const testStep = steps.find((s) => recursiveTestCommands(s.run ?? "").length > 0);
    expect(testStep?.run).toMatch(/pnpm -r --no-bail --reporter-hide-prefix test/);
    expect(testStep?.if).toBe("${{ !cancelled() }}");
  });

  it("the worker-image job's run inside the container carries the flag too", () => {
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
    const worker = steps.filter((s) => /docker run[\s\S]*pnpm -r[\s\S]* test/.test(s.run ?? ""));
    expect(worker.length).toBeGreaterThan(0);
    for (const s of worker) expect(recursiveTestCommands(s.run!).every((c) => c.includes("--reporter-hide-prefix"))).toBe(true);
  });

  it("the caddy-edge test runs through test-shell.sh", () => {
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
    const caddy = steps.filter((s) => (s.run ?? "").includes("caddy-edge.test.sh"));
    expect(caddy.length).toBeGreaterThan(0);
    for (const s of caddy) expect(s.run).toMatch(/scripts\/test-shell\.sh scripts\/caddy-edge\.test\.sh/);
  });

  // The planted examples: the checker must catch the old form of each step, or the tests above prove nothing.
  it("catches the old, prefixed test step and a bare shell test", () => {
    const planted: Workflow = {
      jobs: {
        check: { steps: [{ if: "${{ !cancelled() }}", run: "pnpm -r --no-bail test" }] },
        images: { steps: [{ name: "edge", run: 'CADDY="$RUNNER_TEMP/caddy" scripts/caddy-edge.test.sh' }] },
        worker: { steps: [{ run: "docker run x -c '\n  pnpm -r --no-bail typecheck; tc=$?;\n  pnpm -r --no-bail test; ts=$?;'" }] },
      },
    };
    const faults = unnamedTestSteps(planted);
    expect(faults).toHaveLength(3);
    expect(faults[0]).toMatch(/^check step 1: "pnpm -r --no-bail test" lacks --reporter-hide-prefix/);
    expect(faults[1]).toMatch(/^images step 1 \(edge\): .* runs a shell test bare/);
    expect(faults[2]).toMatch(/^worker step 1: "pnpm -r --no-bail test" lacks/);
  });

  it("does not flag commented-out lines or the fixed forms", () => {
    const fixed: Workflow = {
      jobs: {
        a: { steps: [{ run: "# pnpm -r test\npnpm -r --no-bail --reporter-hide-prefix test" }, { run: 'CADDY=x scripts/test-shell.sh scripts/caddy-edge.test.sh' }, { run: "pnpm -r --no-bail typecheck" }] },
      },
    };
    expect(unnamedTestSteps(fixed)).toEqual([]);
  });

  // BOS-2082: the web-browser job wrote only a summary with base names (run 44899835927), which the merge gate can't re-run.
  // The step's own node script is run on a vitest JSON report, so a change to it is tested as GitHub runs it.
  it("the web-browser job's failure notes name each failed file on its repo path", () => {
    const step = (wf.jobs["web-browser"]?.steps ?? []).find((s) => /--outputFile\.json="\$RUNNER_TEMP\/web-tests\.json"/.test(s.run ?? ""));
    const script = /node -e '\n([\s\S]*?)\n\s*' "\$RUNNER_TEMP\/web-tests\.json"/.exec(step?.run ?? "")?.[1];
    expect(script).toBeTruthy();
    // The script sits in a bash single-quoted string: a ' inside it (a "can't" in a comment, as in review) ends the quote
    // early and the step dies before writing any note. Node alone never sees that, so bash parses the whole step too.
    expect(script).not.toContain("'");
    expect(() => execFileSync("bash", ["-n"], { input: step!.run!, stdio: ["pipe", "pipe", "pipe"] })).not.toThrow();
    const ws = mkdtempSync(join(tmpdir(), "ci-web-notes-"));
    try {
      const report = join(ws, "web-tests.json");
      const file = (name: string, status: string, tests: Array<{ title: string; status: string; msg?: string }>, message = "") => ({
        name: join(ws, name),
        status,
        message,
        assertionResults: tests.map((t) => ({ title: t.title, status: t.status, failureMessages: t.msg ? [t.msg] : [] })),
      });
      writeFileSync(
        report,
        JSON.stringify({
          testResults: [
            file("apps/web/test/page-intro-browser.test.ts", "failed", [{ title: "safari-1550x1611: each place shows its lead", status: "failed", msg: "AssertionError: the lead is on the page\n at x" }, { title: "ok", status: "passed" }]),
            file("apps/web/test/broken.test.ts", "failed", [], "Failed to load url ./nope"),
            file("apps/web/test/fine.test.ts", "passed", [{ title: "fine", status: "passed" }]),
          ],
        }),
      );
      const out = execFileSync("node", ["-e", script!, report], { env: { ...process.env, GITHUB_WORKSPACE: ws }, encoding: "utf8" }).trim().split("\n");
      expect(out[0]).toMatch(/^::error title=web tests failed::page-intro-browser\.test\.ts: safari-1550x1611: each place shows its lead: AssertionError: the lead is on the page \| broken\.test\.ts: Failed to load url \.\/nope$/);
      expect(out.slice(1)).toEqual([
        "::error file=apps/web/test/page-intro-browser.test.ts,title=web test failed::safari-1550x1611: each place shows its lead: AssertionError: the lead is on the page",
        "::error file=apps/web/test/broken.test.ts,title=web test failed::Failed to load url ./nope",
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
