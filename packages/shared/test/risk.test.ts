import { describe, expect, it } from "vitest";
import { namesStaging, stagingLint } from "../src/acceptance.js";
import { riskSummary } from "../src/risk.js";

describe("riskSummary (R61)", () => {
  it("follows the review, check and staging rules for each tier", () => {
    expect(riskSummary(null)).toBe("The CEO reviews it; the project's check runs before it merges; a short plan first.");
    expect(riskSummary("trivial")).toBe("The CEO reviews it; the project's check runs before it merges; no plan needed.");
    expect(riskSummary("critical")).toBe("The CEO reviews it and you sign it off; the project's check and its deeper check run before it merges; it goes to staging before production; a full plan first.");
  });
});

describe("staging in the risk line and the staging lint (BOS-1473)", () => {
  it("drops the staging promise when no staging target is reachable", () => {
    expect(riskSummary("critical", undefined, undefined, false)).not.toContain("staging");
  });
  it("warns on real staging wording, not git's staging area", () => {
    expect(stagingLint(["Checked on staging after the merge"])).toContain("names staging");
    expect(stagingLint(["Verified in the staging environment"])).toContain("names staging");
    expect(stagingLint(["Deploy to staging first"])).toContain("names staging");
    expect(stagingLint(["Only the files in the git staging area are committed", "staged changes are kept", "Staging files are listed"])).toBe("");
    expect(stagingLint(["Unit tests pass"])).toBe("");
  });
});

// BOS-2353: pin the helper's own edges, not stagingLint's wording.
describe("namesStaging (BOS-2353)", () => {
  it("accepts the prepositions and articles that introduce a real staging environment", () => {
    for (const s of ["Checked on staging", "Deploy to staging first", "Run in staging", "Tested against staging", "Seen at staging", "Released via staging", "the staging environment"]) {
      expect(namesStaging(s)).toBe(true);
    }
  });

  it("accepts staging followed by an environment noun, with no preposition", () => {
    for (const s of ["staging environment", "staging server", "staging host", "staging target", "staging deploy", "staging deployment", "staging site", "staging instance"]) {
      expect(namesStaging(s)).toBe(true);
    }
  });

  it("rejects git's staging area, index, changes, files and directory", () => {
    for (const s of ["Only the git staging area is committed", "in the staging index", "the staging changes", "staging file", "staging files", "staging directory", "in the staging area"]) {
      expect(namesStaging(s)).toBe(false);
    }
  });

  it("rejects bare staging, stage and a word merely ending in staging", () => {
    expect(namesStaging("Staging is listed here")).toBe(false);
    expect(namesStaging("Deployed on stage")).toBe(false);
    expect(namesStaging("prestaging server")).toBe(false);
  });

  it("is case-insensitive and allows the article after the preposition", () => {
    expect(namesStaging("ON STAGING")).toBe(true);
    expect(namesStaging("Against the staging environment")).toBe(true);
  });
});

describe("riskSummary with a policy", () => {
  it("names the reviewer and whether the owner signs off", () => {
    expect(riskSummary("low", false, "Sam")).toContain("Sam reviews it;");
    expect(riskSummary("low", true, "Sam")).toContain("Sam reviews it and you sign it off;");
  });
});
