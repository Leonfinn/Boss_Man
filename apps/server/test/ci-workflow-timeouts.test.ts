// BOS-2097: every GitHub job has a time limit, so a hung step fails the run in good time instead of running for GitHub's
// 6-hour default. For a workflow the merge gate waits on (one that runs on the gate's bossman-ci/** pushes), each job and
// the longest chain of jobs along `needs` must also end before the gate stops waiting (CI_TIMING.ceilingMs), so the gate
// sees a red run rather than "still running".
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CI_TIMING } from "../src/services/ci-publish.js";

const dir = new URL("../../../.github/workflows/", import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
const ceilingMin = CI_TIMING.ceilingMs / 60_000;

type Job = { "timeout-minutes"?: unknown; needs?: string | string[] };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };
const load = (f: string) => parse(readFileSync(new URL(f, dir), "utf8")) as Workflow;

/** Whether the workflow runs on the gate's push of a merge copy (branch bossman-ci/<ticket>). */
function gateWaitsOn(wf: Workflow): boolean {
  const on = wf.on as { push?: { branches?: string[] } } | undefined;
  const branches = on?.push?.branches ?? [];
  return branches.some((b) => b === "bossman-ci/**" || b === "**" || b === "*");
}

/** The longest sum of time limits along any `needs` chain ending at `name`. */
function chainMinutes(jobs: Record<string, Job>, name: string, seen = new Set<string>()): number {
  if (seen.has(name)) throw new Error(`needs cycle at ${name}`);
  const job = jobs[name]!;
  const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
  const before = Math.max(0, ...needs.map((n) => chainMinutes(jobs, n, new Set([...seen, name]))));
  return before + Number(job["timeout-minutes"]);
}

describe("GitHub workflow time limits (BOS-2097)", () => {
  it("finds the workflows, and ci.yml is one the gate waits on", () => {
    expect(files).toContain("ci.yml");
    expect(gateWaitsOn(load("ci.yml"))).toBe(true);
  });

  it("gives every job a whole number of minutes in timeout-minutes", () => {
    const missing: string[] = [];
    for (const f of files) {
      for (const [name, job] of Object.entries(load(f).jobs ?? {})) {
        const t = job["timeout-minutes"];
        if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) missing.push(`${f}: job ${name} (timeout-minutes: ${String(t)})`);
      }
    }
    expect(missing, "add timeout-minutes: about 1.5x the job's longest green run (see the comment above jobs: in ci.yml)").toEqual([]);
  });

  it("ends every job the gate waits on, and every needs chain, before the gate's ceiling", () => {
    const over: string[] = [];
    for (const f of files) {
      const wf = load(f);
      if (!gateWaitsOn(wf)) continue;
      const jobs = wf.jobs ?? {};
      for (const name of Object.keys(jobs)) {
        const own = Number(jobs[name]!["timeout-minutes"]);
        if (!(own < ceilingMin)) over.push(`${f}: job ${name} has ${own} min, the gate waits ${ceilingMin}`);
        const chain = chainMinutes(jobs, name);
        if (!(chain < ceilingMin)) over.push(`${f}: the needs chain ending at ${name} adds up to ${chain} min, the gate waits ${ceilingMin}`);
      }
    }
    expect(over).toEqual([]);
  });

  it("the chain sum adds limits along needs (a job's limit plus its longest prerequisite chain)", () => {
    const jobs: Record<string, Job> = {
      a: { "timeout-minutes": 10 },
      b: { "timeout-minutes": 30, needs: "a" },
      c: { "timeout-minutes": 5 },
      d: { "timeout-minutes": 20, needs: ["b", "c"] },
    };
    expect(chainMinutes(jobs, "d")).toBe(60);
  });
});
