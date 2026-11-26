// BOS-1447 (background lane): the pure text helpers of the standing-rules service. The rules are saved as
// the owner or CEO typed them (only outer blank space and CRLF line endings change), checked against the
// length cap, and framed in the brief as notes to weigh rather than instructions to follow.
import { describe, expect, it } from "vitest";
import {
  normalizeStandingRules,
  STANDING_RULES_MAX,
  standingRulesError,
  standingRulesLineCounts,
  standingRulesSection,
  type StandingRules,
} from "../src/services/standing-rules.js";

const rules = (text: string, by: string | null = null): StandingRules => ({ text, by, at: null });
const FRAME = "Notes the owner or your CEO set for every run. Weigh them against the rest of the brief like any other note here.";

describe("normalizeStandingRules", () => {
  it("turns CRLF line endings into LF", () => {
    expect(normalizeStandingRules("First.\r\nSecond.\r\n")).toBe("First.\nSecond.");
  });

  it("strips spaces, tabs and blank lines from both ends only", () => {
    expect(normalizeStandingRules("\n\n   Never force-push.  \n\t\n")).toBe("Never force-push.");
    expect(normalizeStandingRules(" \t\r\n")).toBe("");
  });

  it("keeps blank lines inside the text, so paragraphs survive", () => {
    expect(normalizeStandingRules("First.\r\n\r\nSecond.")).toBe("First.\n\nSecond.");
    expect(normalizeStandingRules("First.\n\n\nSecond.")).toBe("First.\n\n\nSecond.");
  });

  it("leaves text that needs no change exactly as it is", () => {
    expect(normalizeStandingRules("Only the merge gate runs the full check.")).toBe("Only the merge gate runs the full check.");
    expect(normalizeStandingRules("a\n\tb")).toBe("a\n\tb"); // tabs and spacing inside a line are kept
    expect(normalizeStandingRules("")).toBe("");
  });
});

describe("standingRulesError", () => {
  it("accepts text up to and including the limit", () => {
    expect(standingRulesError("")).toBeNull();
    expect(standingRulesError("x".repeat(STANDING_RULES_MAX))).toBeNull();
    // Every character counts, newlines included: 1000 lines of "a\n" are exactly the cap.
    expect(standingRulesError("a\n".repeat(STANDING_RULES_MAX / 2))).toBeNull();
  });

  it("refuses text one character over the limit, naming the limit and the length", () => {
    const problem = standingRulesError("x".repeat(STANDING_RULES_MAX + 1));
    expect(problem).toContain(`at most ${STANDING_RULES_MAX} characters`);
    expect(problem).toContain(String(STANDING_RULES_MAX + 1));
  });

  it("counts the text as given, not after trimming", () => {
    // Normalising happens first in the service; a raw string's outer spaces still count here.
    expect(standingRulesError(` ${"x".repeat(STANDING_RULES_MAX)}`)).toContain(String(STANDING_RULES_MAX + 1));
  });
});

describe("standingRulesLineCounts", () => {
  it("counts the lines added and removed between two texts", () => {
    expect(standingRulesLineCounts("First.\nSecond.", "First.\nSecond.\nThird.")).toEqual({ added: 1, removed: 0 });
    expect(standingRulesLineCounts("First.\nSecond.\nThird.", "First.\nThird.")).toEqual({ added: 0, removed: 1 });
    expect(standingRulesLineCounts("First.\nSecond.", "First.\nThird.")).toEqual({ added: 1, removed: 1 });
  });

  it("counts an empty text as having no lines", () => {
    expect(standingRulesLineCounts("", "")).toEqual({ added: 0, removed: 0 });
    expect(standingRulesLineCounts("", "First.\nSecond.")).toEqual({ added: 2, removed: 0 });
    expect(standingRulesLineCounts("Only one.", "")).toEqual({ added: 0, removed: 1 });
  });

  it("counts a moved line as neither added nor removed", () => {
    expect(standingRulesLineCounts("First.\nSecond.", "Second.\nFirst.")).toEqual({ added: 0, removed: 0 });
  });

  it("counts repeated lines by how many there are", () => {
    expect(standingRulesLineCounts("Same.\nSame.", "Same.")).toEqual({ added: 0, removed: 1 });
    expect(standingRulesLineCounts("Same.", "Same.\nSame.")).toEqual({ added: 1, removed: 0 });
  });
});

describe("standingRulesSection", () => {
  it("is left out when there are no rules", () => {
    expect(standingRulesSection(rules(""))).toEqual([]);
    expect(standingRulesSection(rules("   \r\n\t\n"))).toEqual([]);
  });

  it("adds a blank line, the heading, the frame and the text", () => {
    expect(standingRulesSection(rules("Never force-push."))).toEqual(["", "## Standing rules", FRAME, "", "Never force-push."]);
  });

  it("names who changed the rules last", () => {
    const lines = standingRulesSection(rules("Be kind.", "the owner"));
    expect(lines[2]).toContain("(last changed by the owner)");
  });

  it("does not name an undo as the author", () => {
    expect(standingRulesSection(rules("Be kind.", "undo"))[2]).toBe(FRAME);
  });

  it("trims the text but keeps its inner blank lines", () => {
    expect(standingRulesSection(rules("  One.\n\nTwo.  ")).at(-1)).toBe("One.\n\nTwo.");
  });

  it("frames the rules as notes to weigh, never as instructions to obey", () => {
    const lines = standingRulesSection(rules("Never force-push."));
    expect(lines[2]).toContain("Weigh them against the rest of the brief");
    expect(lines.join("\n")).not.toContain("Follow them like any other instruction");
  });
});
