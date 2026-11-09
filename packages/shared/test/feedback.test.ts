import { describe, expect, it } from "vitest";
import { demandScore, keywords, looksLikeSecurity, portalVerdict, priorityScore, suggestFeatures } from "../src/index.js";

describe("demandScore", () => {
  it("counts each customer once, at their most important level", () => {
    expect(
      demandScore([
        { customerKey: "acme", importance: "nice_to_have" },
        { customerKey: "acme", importance: "critical" },
        { customerKey: "beta", importance: "important" },
        { customerKey: null, importance: "nice_to_have" },
        { customerKey: null, importance: "nice_to_have" },
      ]),
    ).toBe(3 + 2 + 1 + 1);
    expect(demandScore([])).toBe(0);
  });
});

describe("priorityScore", () => {
  it("weighs demand against the criteria, then divides by effort", () => {
    // Demand 5/5 at weight 3, one criterion at 1/5 weight 1: value (15 + 1) / 4 = 4.
    expect(priorityScore({ demand: 10, maxDemand: 10, demandWeight: 3, drivers: [{ weight: 1, value: 1 }], effort: null })).toEqual({ value: 4, demandPart: 5, effort: 3, priority: 4 });
    // The smallest effort triples it: 4 × 3 ÷ 1.
    expect(priorityScore({ demand: 10, maxDemand: 10, demandWeight: 3, drivers: [{ weight: 1, value: 1 }], effort: 1 }).priority).toBe(12);
    // Unscored criteria are left out rather than counted as zero.
    expect(priorityScore({ demand: 5, maxDemand: 10, demandWeight: 1, drivers: [{ weight: 5, value: null }], effort: 5 })).toMatchObject({ value: 2.5, priority: 1.5 });
    expect(priorityScore({ demand: 0, maxDemand: 0, demandWeight: 0, drivers: [], effort: null }).priority).toBe(0);
  });
});

describe("suggestFeatures", () => {
  const features = [
    { id: "dark", title: "Dark mode", description: "A dark theme for the dashboard", highlights: ["the screen is too bright at night"] },
    { id: "export", title: "CSV export", description: "Download reports as spreadsheets" },
    { id: "sso", title: "Single sign-on", description: "Log in with Google or Okta" },
  ];
  it("ranks features by the words they share with the note", () => {
    const s = suggestFeatures("Could the dashboard have a dark theme? It's very bright at night.", features);
    expect(s[0]!.feature.id).toBe("dark");
    expect(s.map((x) => x.feature.id)).not.toContain("sso");
    expect(suggestFeatures("Exporting reports to a spreadsheet please", features)[0]!.feature.id).toBe("export");
    expect(suggestFeatures("the and with", features)).toEqual([]);
  });
  it("stems simple endings", () => {
    expect([...keywords("Exports exporting exported")]).toEqual(["export"]);
  });
});

describe("portalVerdict", () => {
  it("puts an ordinary feature with a public summary on the portal", () => {
    expect(portalVerdict({ title: "Dark mode", description: "A dark theme.", hasPublicSummary: true })).toEqual({ onPortal: true, reason: null });
  });
  it("keeps a security-titled or security-described feature off, and says why", () => {
    expect(portalVerdict({ title: "Rotate API keys", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    expect(portalVerdict({ title: "Settings page", description: "Manage credentials for connected apps.", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    expect(portalVerdict({ title: "Permissions", area: "Security", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    expect(portalVerdict({ title: "Lock it down", criteria: ["Keeps the agent fence sound"], hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
  });
  it("does not trip on ordinary words that merely look close", () => {
    expect(looksLikeSecurity("Keyboard shortcut keys and sorting keys")).toBe(false);
    expect(portalVerdict({ title: "Keyboard shortcuts", hasPublicSummary: true })).toMatchObject({ onPortal: true });
  });
  it("lets the manual keep-off mark win, even over an ordinary feature", () => {
    expect(portalVerdict({ title: "Dark mode", keepOffPortal: true, hasPublicSummary: true })).toEqual({ onPortal: false, reason: "sensitive" });
    expect(portalVerdict({ title: "Dark mode", keepOffPortal: false, hasPublicSummary: true })).toEqual({ onPortal: true, reason: null });
  });
  it("holds a feature without a public summary off until one is written", () => {
    expect(portalVerdict({ title: "Dark mode", hasPublicSummary: false })).toEqual({ onPortal: false, reason: "needs public summary" });
    // Security still wins over a missing summary: the reason it is off is the security work.
    expect(portalVerdict({ title: "Secrets manager", hasPublicSummary: false })).toEqual({ onPortal: false, reason: "security" });
  });
});
