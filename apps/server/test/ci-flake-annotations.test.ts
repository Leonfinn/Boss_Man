// BOS-2448: the merge gate's flake retry (ci-flake.ts) reads which test failed from a GitHub job's failure annotations. Two
// things in a workflow stop it: a test run inside `docker run` with the repo mounted somewhere other than the checkout's
// path (vitest then names `/work/apps/…`, which repoRelative can't cut back, so the path is refused), and a failure note
// with no file (the job then "names no test file"). Run 45323213260's check-worker-image job had both, and a chance failure
// in apps/launcher/test/docker.test.ts sent BOS-2393 back instead of being retried. These checks fail on that ci.yml.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const dir = new URL("../../../.github/workflows/", import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };
const jobs = (f: string) => Object.entries((parse(readFileSync(new URL(f, dir), "utf8")) as Workflow).jobs ?? {});

/** Every `docker run` command in a step's script, continuation lines joined. */
const dockerRuns = (run: string) => run.replace(/\\\n\s*/g, " ").split("\n").filter((l) => /\bdocker run\b/.test(l));

describe("workflows keep test failures readable by the flake retry (BOS-2448)", () => {
  it("a docker run with a work folder mounts and works in $GITHUB_WORKSPACE, so vitest names files the gate can read", () => {
    // not state: the offending lines of this one assertion.
    const bad: string[] = [];
    let seen = 0;
    for (const f of files)
      for (const [name, job] of jobs(f))
        for (const step of job.steps ?? [])
          for (const line of dockerRuns(step.run ?? "")) {
            const w = /\s(?:-w|--workdir)[ =](\S+)/.exec(line);
            if (!w) continue;
            seen++;
            const mount = /\s(?:-v|--volume)[ =]"?[^:\s"]+:([^\s":]+)/.exec(line);
            if (w[1] !== '"$GITHUB_WORKSPACE"' || mount?.[1] !== "$GITHUB_WORKSPACE") bad.push(`${f} ${name}: ${line.trim().slice(0, 160)}`);
          }
    // The check-worker-image job is one such run; if none is found the parse above broke, not the rule.
    expect(seen).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("the check-worker-image job writes its summary notes as warnings, not file-less failures", () => {
    const job = jobs("ci.yml").find(([n]) => n === "check-worker-image")?.[1];
    const run = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(run).toContain("::warning title=check worker image: first errors::");
    expect(run).toContain("::warning title=check worker image: failed tests::");
    expect(run).not.toMatch(/::error title=check worker image/);
  });
});
