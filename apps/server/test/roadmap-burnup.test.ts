import { describe, expect, it } from "vitest";
import { burnupWeeks, paceFromBurnup, type BurnupPoint } from "../src/services/roadmap-burnup.js";

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe("roadmap burn-up (BOS-2397)", () => {
  it("gives 8 weekly points ending today, with done and total as of each week", () => {
    const rows = [
      { size: 5, createdAt: d("2026-09-01"), doneAt: d("2026-10-05") }, // done in week 3 of 8
      { size: 8, createdAt: d("2026-09-01"), doneAt: null },
      { size: 13, createdAt: d("2026-11-20"), doneAt: null }, // scope added in the last week
      { size: null, createdAt: d("2026-09-01"), doneAt: null }, // unsized: not counted
    ];
    const w = burnupWeeks(rows, "2026-11-23");
    expect(w).toHaveLength(8);
    expect(w.at(-1)!.weekEnd).toBe("2026-11-23");
    expect(w[0]).toMatchObject({ weekEnd: "2026-10-05", done: 5, total: 13 });
    expect(w[6]).toMatchObject({ done: 5, total: 13 });
    expect(w[7]).toMatchObject({ done: 5, total: 26 });
  });

  it("steps done up in weeks 2 and 5 and total up in week 6", () => {
    // Weeks end 2026-10-05, 10-12, 10-19, 10-26, 11-02, 11-09, 11-16, 11-23.
    const rows = [
      { size: 3, createdAt: d("2026-09-01"), doneAt: d("2026-10-08") }, // week 2
      { size: 5, createdAt: d("2026-09-01"), doneAt: d("2026-10-30") }, // week 5
      { size: 2, createdAt: d("2026-09-01"), doneAt: null },
      { size: 8, createdAt: d("2026-11-04"), doneAt: null }, // added in week 6
    ];
    const w = burnupWeeks(rows, "2026-11-23");
    expect(w.map((p) => p.done)).toEqual([0, 3, 3, 3, 8, 8, 8, 8]);
    expect(w.map((p) => p.total)).toEqual([10, 10, 10, 10, 10, 18, 18, 18]);
  });

  it("leaves out work created after a week, and is all zero with no sized work", () => {
    expect(burnupWeeks([], "2026-11-23").every((p) => p.done === 0 && p.total === 0)).toBe(true);
    const w = burnupWeeks([{ size: 3, createdAt: d("2026-11-22"), doneAt: null }], "2026-11-23");
    expect(w.map((p) => p.total)).toEqual([0, 0, 0, 0, 0, 0, 0, 3]);
  });
});

describe("paceFromBurnup", () => {
  const points = (done: number[]): BurnupPoint[] =>
    done.map((n, i) => ({ weekEnd: `2026-10-${String(i + 5).padStart(2, "0")}`, done: n, total: 100 }));

  it("is the points finished in the last 4 weeks over 4, for steady progress", () => {
    // 8 weekly points, done rising by 2 a week: the last 4 weeks (index 3 to 7) close 8 points, so 2 a week.
    expect(paceFromBurnup(points([10, 12, 14, 16, 18, 20, 22, 24]))).toBe(2);
  });

  it("is zero with too few points or no progress, and never negative", () => {
    expect(paceFromBurnup([])).toBe(0);
    expect(paceFromBurnup(points([10, 12, 14, 16, 18, 20, 22]))).toBe(0); // 7 points: fewer than the 8 it needs
    expect(paceFromBurnup(points([10, 10, 10, 10, 10, 10, 10, 10]))).toBe(0); // no progress
    expect(paceFromBurnup(points([10, 10, 10, 20, 15, 15, 15, 15]))).toBe(0); // work reopened: done fell, clamped to 0
  });
});
