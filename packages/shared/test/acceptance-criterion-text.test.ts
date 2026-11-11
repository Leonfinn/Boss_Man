import { describe, expect, it } from "vitest";
import { criteriaText, criterionOverlap, criterionText, type Criterion } from "../src/acceptance.js";

// The review and done gates read criteria through these three helpers (BOS-963): the text of a
// criterion without its after-merge mark, a list of them in order, and how close another piece of
// text is to one when an agent's report names none.

describe("criterionText", () => {
  it("gives the text of a plain string criterion as it is", () => {
    expect(criterionText("Health check returns 200")).toBe("Health check returns 200");
  });

  it("gives the text of an after-merge criterion without its mark", () => {
    expect(criterionText({ text: "Load stays under 2s once live", after: "merge" })).toBe("Load stays under 2s once live");
  });

  it("keeps the criterion's own spacing and case", () => {
    expect(criterionText("  Docs: updated for the Owner  ")).toBe("  Docs: updated for the Owner  ");
    expect(criterionText({ text: "Secrets are NEVER logged", after: "merge" })).toBe("Secrets are NEVER logged");
  });
});

describe("criteriaText", () => {
  it("lists every criterion's text in order, plain and after-merge alike", () => {
    const criteria: Criterion[] = ["Health check returns 200", { text: "Backup restores cleanly", after: "merge" }, "Secrets are never logged"];
    expect(criteriaText(criteria)).toEqual(["Health check returns 200", "Backup restores cleanly", "Secrets are never logged"]);
  });

  it("keeps duplicates and order, so a number the gate reads back names the right criterion", () => {
    const criteria: Criterion[] = [{ text: "Second by position", after: "merge" }, "Second by position", "Third"];
    expect(criteriaText(criteria)).toEqual(["Second by position", "Second by position", "Third"]);
  });

  it("gives an empty list for no criteria", () => {
    expect(criteriaText([])).toEqual([]);
  });
});

describe("criterionOverlap", () => {
  it("counts the criterion's words that the text carries", () => {
    expect(criterionOverlap("Health check returns 200", "health check returns 200")).toBe(4);
    expect(criterionOverlap("Health check returns 200", "the health check is slow")).toBe(2);
  });

  it("ignores case and punctuation on both sides", () => {
    expect(criterionOverlap("Health check returns 200", "HEALTH, check: returns 200!")).toBe(4);
    expect(criterionOverlap("Migration is expand-only", "migration: expand only, then backfill")).toBe(3);
  });

  it("gives 0 when the text shares none of the criterion's words", () => {
    expect(criterionOverlap("Health check returns 200", "Docs updated for the owner")).toBe(0);
    expect(criterionOverlap("Health check returns 200", "")).toBe(0);
  });

  it("gives a higher count for a closer paraphrase than for one that only shares the subject", () => {
    const criterion = "The health check returns 200 on the deploy";
    const close = criterionOverlap(criterion, "The health check returns 200");
    const loose = criterionOverlap(criterion, "The health check is slow");
    expect(close).toBeGreaterThan(loose);
    expect(close).toBe(4);
    expect(loose).toBe(2);
  });

  it("counts only the criterion's own words, once each", () => {
    expect(criterionOverlap("Health check", "Health check returns 200 and more health details")).toBe(2);
  });
});
