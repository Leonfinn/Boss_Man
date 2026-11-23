// BOS-2360: with GitHub CI gating on, the merge train pushes each member's merge commit stacked on the merge commits of the
// tickets ahead. Its first parent is then the ticket ahead, not main, so the `changes` job in ci.yml must diff a bossman-ci
// push against its merge-base with main: a diff against `^1` would skip the image jobs for an image change made by a ticket
// ahead, and that ticket lands on this run's pass (a pass further back covers the tickets ahead).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const wf = parse(readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")) as { jobs: Record<string, { steps?: Array<{ run?: string }> }> };

/** The shell of the `changes` job's step that picks the images flag for a gate or branch push. */
function changesScript(): string {
  const steps = wf.jobs.changes?.steps ?? [];
  const run = steps.map((s) => s.run ?? "").find((r) => r.includes("refs/heads/bossman-ci/"));
  if (!run) throw new Error("ci.yml: no `changes` step handles bossman-ci pushes");
  return run;
}

describe("ci.yml: the images diff of a gate push (BOS-2360)", () => {
  it("diffs a bossman-ci push against its merge-base with main, never against the first parent", () => {
    const run = changesScript();
    const block = run.slice(run.indexOf("push:refs/heads/bossman-ci/*"), run.indexOf("esac", run.indexOf("push:refs/heads/bossman-ci/*")));
    expect(block).toContain('git merge-base origin/main "$GITHUB_SHA"');
    expect(block).not.toMatch(/GITHUB_SHA\^1/);
  });
});
