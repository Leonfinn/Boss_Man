import { describe, expect, it } from "vitest";
import { RISK_TIERS, deepChecks, riskOf, stagingFirst, type RiskTier } from "../src/risk.js";

const SERIOUS: Record<RiskTier, boolean> = { trivial: false, low: false, medium: false, high: true, critical: true };

describe("riskOf: a ticket's tier, with unrated work treated as medium", () => {
  it("returns every tier unchanged", () => {
    for (const tier of RISK_TIERS) expect(riskOf(tier), tier).toBe(tier);
  });

  it("treats a missing risk as medium", () => {
    expect(riskOf(null)).toBe("medium");
    expect(riskOf(undefined)).toBe("medium");
  });

  it("treats an explicit medium the same as an unrated ticket", () => {
    expect(riskOf("medium")).toBe(riskOf(null));
    expect(riskOf("medium")).toBe(riskOf(undefined));
  });
});

describe("deepChecks: only high and critical work gets the deeper check", () => {
  it("is true only for high and critical", () => {
    for (const tier of RISK_TIERS) expect(deepChecks(tier), tier).toBe(SERIOUS[tier]);
  });

  it("is false for unrated work, which is medium", () => {
    expect(deepChecks(null)).toBe(false);
    expect(deepChecks(undefined)).toBe(false);
  });
});

describe("stagingFirst: only high and critical work ships to staging first", () => {
  it("is true only for high and critical", () => {
    for (const tier of RISK_TIERS) expect(stagingFirst(tier), tier).toBe(SERIOUS[tier]);
  });

  it("is false for unrated work, which is medium", () => {
    expect(stagingFirst(null)).toBe(false);
    expect(stagingFirst(undefined)).toBe(false);
  });
});

describe("the serious-work helpers agree, and the tiers keep their order", () => {
  it("deepChecks and stagingFirst give the same answer, with or without a tier", () => {
    const risks: Array<RiskTier | null | undefined> = [...RISK_TIERS, null, undefined];
    for (const risk of risks) expect(deepChecks(risk), String(risk)).toBe(stagingFirst(risk));
  });

  it("lists the tiers from least to most severe, which their order-based comparisons rely on", () => {
    expect(RISK_TIERS).toEqual(["trivial", "low", "medium", "high", "critical"]);
  });
});
