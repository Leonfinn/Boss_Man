import { describe, expect, it } from "vitest";
import { highestRisk } from "../src/services/review.js";

// BOS-130: a merge that carries other tickets' work gets the highest risk among them, and
// unrated tickets count as medium (riskOf in packages/shared/src/risk.ts).

describe("highestRisk", () => {
  it.each(["trivial", "low", "medium", "high", "critical"] as const)("gives back a single %s tier", (tier) => {
    expect(highestRisk([tier])).toBe(tier);
  });

  it("picks the highest tier whatever the order", () => {
    expect(highestRisk(["low", "critical", "medium"])).toBe("critical");
    expect(highestRisk(["critical", "low"])).toBe("critical");
    expect(highestRisk(["medium", "high", "low"])).toBe("high");
  });

  it("counts null and undefined as medium", () => {
    expect(highestRisk(["trivial", null])).toBe("medium");
    expect(highestRisk([null, "high"])).toBe("high");
    expect(highestRisk([undefined])).toBe("medium");
  });

  it("gives trivial for an empty list, pinning what the reduce does today", () => {
    expect(highestRisk([])).toBe("trivial");
  });
});
