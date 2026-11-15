// planFiles runs on the server's main thread when a plan is approved. Long text with no separators used to take
// the square of its length (40,000 chars: 1 to 2 s; BOS-1529). The limits below are timed against a baseline run
// on the same machine (CLAUDE.md test rules), so they hold on a slow runner too. They still catch a return of the
// quadratic regexes: the old code took hundreds of times the baseline on these inputs.
import { describe, expect, it } from "vitest";
import { planFiles } from "../src/services/merge-line-conflicts.js";

function timeMs(fn: () => void): number {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

/** Best of a few runs, so one scheduler hiccup doesn't decide it. */
function best(fn: () => void): number {
  return Math.min(timeMs(fn), timeMs(fn), timeMs(fn));
}

describe("planFiles on long hostile text (BOS-1529)", () => {
  const baselineText = `## Files\n${"- apps/server/src/a.ts\n".repeat(1800)}`.slice(0, 40_000);
  const baseline = Math.max(best(() => planFiles(baselineText)), 1);
  // 30x the baseline, with a floor for timer noise; the old code was 1000x or more.
  const limit = baseline * 30 + 50;

  it("one 40k token with no dot near the end", () => {
    const text = `## Files\n- ${"a".repeat(40_000)}`;
    let out: string[] = [];
    const ms = best(() => { out = planFiles(text); });
    expect(out).toEqual([]);
    expect(ms).toBeLessThan(limit);
  });

  it("one 40k path-like token of word characters and slashes", () => {
    const text = `Files: ${"a/".repeat(20_000)}`;
    const ms = best(() => planFiles(text));
    expect(ms).toBeLessThan(limit);
  });

  it("a 40k line that is mostly whitespace", () => {
    const text = `${" ".repeat(40_000)}x`;
    const ms = best(() => planFiles(text));
    expect(ms).toBeLessThan(limit);
  });

  it("a 40k whitespace run after the Files heading", () => {
    const text = `## Files\n- real.ts\n- ${" ".repeat(40_000)}`;
    let out: string[] = [];
    const ms = best(() => { out = planFiles(text); });
    expect(out).toEqual(["real.ts"]);
    expect(ms).toBeLessThan(limit);
  });

  it("still reads the heading shapes it read before", () => {
    expect(planFiles("**Files:**\n- one.ts")).toEqual(["one.ts"]);
    expect(planFiles("### The Files\n1. a/b.ts\n2) c.tsx")).toEqual(["a/b.ts", "c.tsx"]);
    expect(planFiles("__Files__: x.ts, y/z.md")).toEqual(["x.ts", "y/z.md"]);
  });
});
