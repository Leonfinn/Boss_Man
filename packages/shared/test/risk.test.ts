import { describe, expect, it } from "vitest";
import { riskSummary } from "../src/risk.js";

describe("riskSummary (R61)", () => {
  it("follows the review, check and staging rules for each tier", () => {
    expect(riskSummary(null)).toBe("The CEO reviews it; the project's check runs before it merges; a short plan first.");
    expect(riskSummary("trivial")).toBe("The CEO reviews it; the project's check runs before it merges; no plan needed.");
    expect(riskSummary("critical")).toBe("The CEO reviews it and you sign it off; the project's check and its deeper check run before it merges; it goes to staging before production; a full plan first.");
  });
});

describe("riskSummary with a policy", () => {
  it("names the reviewer and whether the owner signs off", () => {
    expect(riskSummary("low", false, "Sam")).toContain("Sam reviews it;");
    expect(riskSummary("low", true, "Sam")).toContain("Sam reviews it and you sign it off;");
  });
});
