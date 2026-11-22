import { describe, expect, it } from "vitest";
import { stagger } from "./stagger-sequencer.js";

describe("stagger (BOS-2220: the biggest files must not start together)", () => {
  const heavy = (s: string) => s.startsWith("H");

  it("starts one heavy file first and spaces the others a gap apart", () => {
    const order = ["H1", "H2", "H3", "H4", ...Array.from({ length: 30 }, (_, i) => `f${i}`)];
    const out = stagger(order, heavy, 8);
    expect(out.indexOf("H1")).toBe(0);
    expect(out.indexOf("H2")).toBe(8);
    expect(out.indexOf("H3")).toBe(16);
    // The first 4 slots (one round of 4 workers) hold at most one heavy file.
    expect(out.slice(0, 4).filter(heavy)).toHaveLength(1);
  });

  it("keeps every file once and the light files in their original order", () => {
    const order = ["H1", "H2", "a", "b", "c", "H3", "d"];
    const out = stagger(order, heavy, 4);
    expect([...out].sort()).toEqual([...order].sort());
    expect(out.filter((x) => !heavy(x))).toEqual(["a", "b", "c", "d"]);
  });

  it("puts leftover heavy files at the end when the light ones run out", () => {
    expect(stagger(["H1", "H2", "H3", "a"], heavy, 8)).toEqual(["H1", "a", "H2", "H3"]);
  });

  it("changes nothing when no file is heavy", () => {
    expect(stagger(["a", "b", "c"], heavy, 8)).toEqual(["a", "b", "c"]);
  });
});
