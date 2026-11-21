// BOS-2067 (background lane): the pure helpers behind the CEO's lint override. A stored override is either the old
// plain reason or a JSON list, the list is cleaned (steps de-duplicated and sorted, rules de-duplicated, reason
// whitespace collapsed), and the covered findings are shown one "Step 3 (R19): reason" line per entry. An override
// reason under 10 characters is refused (overrideTooShort, BOS-2127). No database and no network.
import { describe, expect, it } from "vitest";
import { type CoveredOverride, overrideLines, overrideTooShort, parseStoredOverride } from "../src/services/lint-override.js";

describe("parseStoredOverride", () => {
  it("has nothing for a missing, empty or whitespace-only value", () => {
    expect(parseStoredOverride(null)).toBeUndefined();
    expect(parseStoredOverride(undefined)).toBeUndefined();
    expect(parseStoredOverride("")).toBeUndefined();
    expect(parseStoredOverride("   ")).toBeUndefined();
  });

  it("trims a plain reason", () => {
    expect(parseStoredOverride("  Owner did it  ")).toBe("Owner did it");
  });

  it("cleans a valid list: steps sorted and de-duplicated, rules de-duplicated, reason collapsed", () => {
    const stored = JSON.stringify([{ steps: [3, 1, 3], rules: ["R19", "R19"], reason: "  host   ok " }]);
    expect(parseStoredOverride(stored)).toEqual([{ steps: [1, 3], rules: ["R19"], reason: "host ok" }]);
  });

  it("drops an empty rules list", () => {
    const stored = JSON.stringify([{ steps: [2], rules: [], reason: "fine reason" }]);
    expect(parseStoredOverride(stored)).toEqual([{ steps: [2], reason: "fine reason" }]);
  });

  it("returns anything that isn't a valid list as the plain reason it is", () => {
    expect(parseStoredOverride("[not json")).toBe("[not json");
    expect(parseStoredOverride("[]")).toBe("[]");
    expect(parseStoredOverride('[{"steps":[]}]')).toBe('[{"steps":[]}]');
  });

  it("cleans each entry of a list", () => {
    const stored = JSON.stringify([
      { steps: [2], rules: ["R17"], reason: "  a   b " },
      { steps: [4, 2], reason: " c " },
    ]);
    expect(parseStoredOverride(stored)).toEqual([
      { steps: [2], rules: ["R17"], reason: "a b" },
      { steps: [2, 4], reason: "c" },
    ]);
  });
});

const finding = (step: number, rule: "R17" | "R19", problem = "a problem"): CoveredOverride["findings"][number] => ({ step, rule, problem });

describe("overrideLines", () => {
  it("has nothing for no covered findings", () => {
    expect(overrideLines([])).toBe("");
  });

  it("shows one entry's one finding with its step and rule", () => {
    expect(overrideLines([{ reason: "reason", findings: [finding(3, "R19")] }])).toBe("Step 3 (R19): reason");
  });

  it("joins two findings in one entry with a comma", () => {
    const covered: CoveredOverride[] = [{ reason: "reason", findings: [finding(3, "R19"), finding(4, "R17")] }];
    expect(overrideLines(covered)).toBe("Step 3 (R19), Step 4 (R17): reason");
  });

  it("puts two entries on two lines", () => {
    const covered: CoveredOverride[] = [
      { reason: "first", findings: [finding(2, "R17")] },
      { reason: "second", findings: [finding(5, "R19")] },
    ];
    expect(overrideLines(covered)).toBe("Step 2 (R17): first\nStep 5 (R19): second");
  });
});

describe("overrideTooShort", () => {
  it("refuses a plain reason shorter than 10 characters", () => {
    expect(overrideTooShort("short")).toBe(true);
    expect(overrideTooShort("123456789")).toBe(true);
    expect(overrideTooShort("")).toBe(true);
  });

  it("accepts a plain reason of exactly 10 characters or more", () => {
    expect(overrideTooShort("1234567890")).toBe(false);
    expect(overrideTooShort("this one is long enough")).toBe(false);
  });

  it("refuses a list when any entry's reason is too short", () => {
    expect(overrideTooShort([{ steps: [1], reason: "long enough reason" }, { steps: [2], reason: "too short" }])).toBe(true);
    expect(overrideTooShort([{ steps: [1], reason: "short" }])).toBe(true);
  });

  it("accepts a list whose reasons are all long enough, and an empty list", () => {
    expect(overrideTooShort([{ steps: [1], reason: "long enough reason" }, { steps: [2], reason: "1234567890" }])).toBe(false);
    expect(overrideTooShort([])).toBe(false);
  });
});
