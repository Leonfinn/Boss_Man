// BOS-1839: the pure helpers behind Settings' per-machine check-slot row (BOS-1602).
// The owner picks what a machine takes and how many of its slots are kept for merge checks;
// these pin the sentence shown on the row and the check the form uses before saving.
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, policyLine, policyValid, type SlotPolicy } from "../src/pages/settings/SlotSplit";

const both = (mergeKept: number): SlotPolicy => ({ takes: "both", mergeKept });

describe("policyLine: a machine's row in plain words", () => {
  it("a machine with nothing set takes both kinds and keeps no slots", () => {
    expect(DEFAULT_POLICY).toEqual({ takes: "both", mergeKept: 0 });
    expect(policyLine(undefined, 3)).toBe("Merge checks and quick checks");
    expect(policyLine(both(0), 3)).toBe("Merge checks and quick checks");
  });

  it("names a machine that takes only one kind, ignoring kept slots for that kind", () => {
    expect(policyLine({ takes: "merge", mergeKept: 2 }, 3)).toBe("Merge checks only");
    expect(policyLine({ takes: "checks", mergeKept: 2 }, 3)).toBe("Quick checks only");
  });

  it("says how many slots are kept, with the right singular or plural", () => {
    expect(policyLine(both(2), 3)).toBe("Merge checks and quick checks, 2 of 3 slots kept for merge checks");
    expect(policyLine(both(1), 1)).toBe("Merge checks and quick checks, 1 of 1 slot kept for merge checks");
  });

  it("never claims more kept slots than the machine has", () => {
    expect(policyLine(both(9), 2)).toBe("Merge checks and quick checks, 2 of 2 slots kept for merge checks");
  });
});

describe("policyValid: kept slots must fit the machine", () => {
  it("accepts whole numbers from zero up to the slot count", () => {
    expect(policyValid(both(0), 3)).toBe(true);
    expect(policyValid(both(3), 3)).toBe(true);
    expect(policyValid(both(1), 1)).toBe(true);
  });

  it("refuses more kept slots than the machine has, negative numbers, fractions and blanks", () => {
    expect(policyValid(both(4), 3)).toBe(false);
    expect(policyValid(both(-1), 3)).toBe(false);
    expect(policyValid(both(1.5), 3)).toBe(false);
    expect(policyValid(both(Number.NaN), 3)).toBe(false);
  });

  it("does not check kept slots when a machine takes only one kind", () => {
    expect(policyValid({ takes: "merge", mergeKept: 99 }, 3)).toBe(true);
    expect(policyValid({ takes: "checks", mergeKept: -1 }, 3)).toBe(true);
  });
});
