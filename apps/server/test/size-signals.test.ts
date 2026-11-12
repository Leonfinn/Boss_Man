// Sizing notes on the workflow scorecard (docs/19-workflow-retros.md part 6): "3s that behave like 5s".
import { describe, expect, it } from "vitest";
import { sizeSignals, type SizeRow } from "../src/services/workflow.js";

const row = (role: string, size: number, p50CycleMs: number | null, done = 10): SizeRow => ({
  role,
  size,
  done,
  p50CycleMs,
  p85CycleMs: null,
  meanCostMicros: null,
  meanRework: null,
});

describe("sizeSignals", () => {
  it("flags a size whose median sits nearer the next size up, with every field of the note", () => {
    const out = sizeSignals([row("engineer", 2, 1_000), row("engineer", 3, 4_000), row("engineer", 5, 5_000)]);
    expect(out).toEqual([{ role: "engineer", size: 3, likeSize: 5, p50CycleMs: 4_000, nextP50Ms: 5_000, prevP50Ms: 1_000 }]);
  });

  it("leaves a size alone when its median is nearer the size below, or exactly between the two", () => {
    expect(sizeSignals([row("engineer", 2, 1_000), row("engineer", 3, 1_500), row("engineer", 5, 5_000)])).toEqual([]);
    expect(sizeSignals([row("engineer", 2, 1_000), row("engineer", 3, 3_000), row("engineer", 5, 5_000)])).toEqual([]);
  });

  it("needs a neighbour on both sides: the smallest and largest sizes, and a role with only two, are never flagged", () => {
    // Size 2 is closest to 3 and size 5 closest to 3, but neither has a neighbour on its open side.
    expect(sizeSignals([row("engineer", 2, 1_000), row("engineer", 3, 1_500), row("engineer", 5, 2_000)])).toEqual([]);
    expect(sizeSignals([row("engineer", 2, 1_000), row("engineer", 3, 1_100)])).toEqual([]);
  });

  it("leaves out a size with too few timed tickets (or no median), so its neighbours become each other's neighbours", () => {
    const tooFew = [row("engineer", 2, 1_000), row("engineer", 3, 4_000, 2), row("engineer", 5, 6_000), row("engineer", 8, 9_000)];
    expect(sizeSignals(tooFew)).toEqual([{ role: "engineer", size: 5, likeSize: 8, p50CycleMs: 6_000, nextP50Ms: 9_000, prevP50Ms: 1_000 }]);
    // Sanity check: were the thin size counted, the note would land on size 3 instead.
    const allCounted = [row("engineer", 2, 1_000), row("engineer", 3, 4_000), row("engineer", 5, 6_000), row("engineer", 8, 9_000)];
    expect(sizeSignals(allCounted)).toEqual([{ role: "engineer", size: 3, likeSize: 5, p50CycleMs: 4_000, nextP50Ms: 6_000, prevP50Ms: 1_000 }]);
    // A row with no median is dropped the same way.
    expect(sizeSignals([row("engineer", 2, 1_000), row("engineer", 3, null), row("engineer", 5, 6_000), row("engineer", 8, 9_000)])).toEqual([
      { role: "engineer", size: 5, likeSize: 8, p50CycleMs: 6_000, nextP50Ms: 9_000, prevP50Ms: 1_000 },
    ]);
  });

  it("uses the timed counter, not done, for how many tickets a size really has", () => {
    const rows = [row("engineer", 2, 1_000), row("engineer", 3, 6_000), row("engineer", 5, 9_000)];
    expect(sizeSignals(rows)).toEqual([{ role: "engineer", size: 3, likeSize: 5, p50CycleMs: 6_000, nextP50Ms: 9_000, prevP50Ms: 1_000 }]);
    // done is high on every row, but only two size-3 tickets were timed, so size 3 drops out.
    expect(sizeSignals(rows, (r) => (r.size === 3 ? 2 : 10))).toEqual([]);
  });

  it("keeps roles apart: one role's rows are never neighbours of another's", () => {
    // Mixed together these four would flag both 3 and 5; grouped by role neither has an inner size.
    const rows = [row("engineer", 2, 1_000), row("designer", 3, 4_000), row("engineer", 5, 5_000), row("designer", 8, 8_000)];
    expect(sizeSignals(rows)).toEqual([]);
  });

  it("does not depend on the order rows arrive in", () => {
    const sorted = [row("engineer", 2, 1_000), row("engineer", 3, 4_000), row("engineer", 5, 5_000)];
    const shuffled = [sorted[2]!, sorted[0]!, sorted[1]!];
    expect(sizeSignals(shuffled)).toEqual(sizeSignals(sorted));
    expect(sizeSignals(shuffled)).toHaveLength(1);
  });
});
