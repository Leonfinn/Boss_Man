import { describe, expect, it } from "vitest";
import { diffCounts, diffLines, foldDiff } from "../src/line-diff";

describe("wiki version compare line diff (BOS-2198)", () => {
  it("marks added and removed lines", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc\nd");
    expect(d.map((l) => `${l.kind}:${l.text}`)).toEqual(["same:a", "del:b", "add:B", "same:c", "add:d"]);
    expect(diffCounts(d)).toEqual({ added: 2, removed: 1 });
  });

  it("handles identical and empty sides", () => {
    expect(diffCounts(diffLines("x\ny", "x\ny"))).toEqual({ added: 0, removed: 0 });
    expect(diffCounts(diffLines("", "x\ny"))).toEqual({ added: 2, removed: 0 });
    expect(diffCounts(diffLines("x\ny", ""))).toEqual({ added: 0, removed: 2 });
  });

  it("rebuilds both texts from the diff", () => {
    const a = "1\n2\n3\n4\n5\n6\n7";
    const b = "1\nx\n3\n5\n6\n6b\n7\n8";
    const d = diffLines(a, b);
    expect(d.filter((l) => l.kind !== "add").map((l) => l.text).join("\n")).toBe(a);
    expect(d.filter((l) => l.kind !== "del").map((l) => l.text).join("\n")).toBe(b);
  });

  it("folds long unchanged runs, keeping three lines beside a change", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const changed = [...body];
    changed[10] = "changed";
    const blocks = foldDiff(diffLines(body.join("\n"), changed.join("\n")));
    const folded = blocks.filter((b) => b.kind === "folded");
    expect(folded.map((b) => b.lines.length)).toEqual([7, 6]);
  });

  // The limit is generous for slow CI machines; it catches an accidental quadratic walk, which takes many seconds here.
  it("compares a 40,000-character page with scattered edits quickly", () => {
    const a = Array.from({ length: 2000 }, (_, i) => `row ${i} of the page text`);
    const b = a.filter((_, i) => i % 50 !== 0).map((l, i) => (i % 70 === 0 ? l + " edited" : l));
    const t0 = performance.now();
    const d = diffLines(a.join("\n"), b.join("\n"));
    const LIMIT_MS = 3000;
    expect(performance.now() - t0).toBeLessThan(LIMIT_MS);
    expect(d.filter((l) => l.kind !== "add").length).toBeGreaterThanOrEqual(2000);
  });
});
