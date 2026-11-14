import { describe, expect, it } from "vitest";
import { demandScore, keywords, looksLikeSecurity, looksLikeSecurityPhrase, portalTitle, portalVerdict, priorityScore, suggestFeatures } from "../src/index.js";

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
  it("does not hold ordinary features off just because a criterion is named Security (BOS-1260)", () => {
    // The company scores every feature on a criterion called "Security" ("how much this improves security"), so a
    // row graded on it is ordinary work, not security work. The owner saw these two wrongly marked "kept off: security".
    expect(portalVerdict({ title: "Release log", criteria: ["Improves Boss Man", "Reach", "Reduces owner", "Security"], hasPublicSummary: true })).toEqual({ onPortal: true, reason: null });
    expect(portalVerdict({ title: "Public changelog page (from the Release log)", criteria: ["Improves Boss Man", "Reach", "Reduces owner", "Security"], hasPublicSummary: true })).toEqual({ onPortal: true, reason: null });
  });
  it("still holds a real security title off, whatever its criteria say (BOS-991 guard)", () => {
    expect(portalVerdict({ title: "Rotate the host-deployer token", criteria: ["Reach", "Security"], hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    expect(looksLikeSecurityPhrase("Keeps the agent fence sound")).toBe(true);
    expect(looksLikeSecurityPhrase("Security")).toBe(false);
  });
  it("splits hyphenated and possessive words, matching the migration's SQL rule", () => {
    expect(looksLikeSecurity("Token-based login")).toBe(true);
    expect(looksLikeSecurity("password-reset flow")).toBe(true);
    expect(looksLikeSecurity("Fix the token's expiry")).toBe(true);
    expect(portalVerdict({ title: "Token-based login", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    expect(portalVerdict({ title: "Password-reset page", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
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
  it("judges the public title and summary once written, not the internal description (BOS-1419)", () => {
    // The internal description names an API key, but visitors never see it, and the public copy is clean.
    expect(portalVerdict({ title: "Add Synthetic as a model provider", description: "Store the API key in the vault.", publicSummary: "Use another provider for models.", hasPublicSummary: true })).toEqual({ onPortal: true, reason: null });
    expect(portalVerdict({ title: "Token rotation", description: "Internal.", publicTitle: "Weekly tidy-up", publicSummary: "Smaller chores each week.", hasPublicSummary: true })).toEqual({ onPortal: true, reason: null });
  });
  it("still refuses when the public summary itself names a key, token, password, host or IP (BOS-1419)", () => {
    expect(portalVerdict({ title: "Dark mode", publicSummary: "Add your API key to sync.", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    expect(portalVerdict({ title: "Dark mode", publicTitle: "Rotate the token", publicSummary: "A quick weekly job.", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    expect(portalVerdict({ title: "Dark mode", publicSummary: "Store your password safely.", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    expect(portalVerdict({ title: "Dark mode", publicSummary: "Runs on 192.168.1.50.", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    expect(portalVerdict({ title: "Dark mode", publicSummary: "Tell the hostname to the team.", hasPublicSummary: true })).toEqual({ onPortal: false, reason: "security" });
    // A three-part version number is not an address.
    expect(portalVerdict({ title: "Dark mode", publicSummary: "Like our 1.2.0 release notes.", hasPublicSummary: true })).toEqual({ onPortal: true, reason: null });
  });
  it("still judges the internal text when there is no public summary (BOS-1419)", () => {
    expect(portalVerdict({ title: "Add Synthetic as a model provider", description: "Store the API key in the vault.", hasPublicSummary: false })).toEqual({ onPortal: false, reason: "security" });
    // A clean internal feature with no summary still waits for one.
    expect(portalVerdict({ title: "Dark mode", description: "A dark theme.", hasPublicSummary: false })).toEqual({ onPortal: false, reason: "needs public summary" });
  });
  it("keeps a hand-marked feature off whatever its clean summary says (BOS-1357)", () => {
    expect(portalVerdict({ title: "Dark mode", publicSummary: "A dark theme you can switch on.", keepOffPortal: true, hasPublicSummary: true })).toEqual({ onPortal: false, reason: "sensitive" });
  });
});

describe("portalTitle", () => {
  it("prefers the public title, then the public summary's first line, and nothing when neither is written", () => {
    expect(portalTitle("Settings, tidied", "A summary.")).toBe("Settings, tidied");
    expect(portalTitle("  ", "A dark theme you can switch on.\nTeam-only detail.")).toBe("A dark theme you can switch on.");
    expect(portalTitle(null, null)).toBeNull();
    expect(portalTitle("  ", "   \n")).toBeNull();
  });
});

describe("QA: portalTitle never falls back to anything internal (BOS-991)", () => {
  it("takes only the first line, handles CRLF, trims and caps it at 200 characters", () => {
    expect(portalTitle(undefined, "First line.\r\nSecond line with internal detail.")).toBe("First line.");
    expect(portalTitle("", "  \n  Real line after a blank one.")).toBe("Real line after a blank one.");
    expect(portalTitle(null, "x".repeat(500))).toBe("x".repeat(200));
    expect(portalTitle("  Padded  ", null)).toBe("Padded");
  });
});
