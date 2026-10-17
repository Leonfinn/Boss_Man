import { describe, expect, it } from "vitest";
import { riskSummary } from "../src/risk.js";

describe("riskSummary (R61)", () => {
  it("follows the review, check and staging rules for each tier", () => {
    expect(riskSummary(null)).toBe("The CEO reviews it; the project's check runs before it merges; a short plan first.");
    expect(riskSummary("trivial")).toBe("The CEO reviews it; the project's check runs before it merges; no plan needed.");
    expect(riskSummary("critical")).toBe("You review it, not the CEO; the project's check and its deeper check run before it merges; it goes to staging before production; a full plan first.");
  });
});
