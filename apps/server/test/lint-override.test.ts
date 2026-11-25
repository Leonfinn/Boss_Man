// BOS-2067 (background lane): the pure helpers behind the CEO's lint override. A stored override is either the old
// plain reason or a JSON list, the list is cleaned (steps de-duplicated and sorted, rules de-duplicated, reason
// whitespace collapsed), and the covered findings are shown one "Step 3 (R19): reason" line per entry. An override
// reason under 10 characters is refused (overrideTooShort, BOS-2127). Cleaning and serialising a value round-trip
// through the stored form (cleanOverride, serializeOverride, BOS-2446), and resolveOverride matches the refusals
// against the override (strict at write time refuses an entry that names nothing; uncoveredLines prints what is left).
// No database and no network.
import { describe, expect, it } from "vitest";
import {
  type CoveredOverride,
  cleanOverride,
  overrideLines,
  overrideTooShort,
  parseStoredOverride,
  resolveOverride,
  serializeOverride,
  uncoveredLines,
} from "../src/services/lint-override.js";

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

describe("cleanOverride", () => {
  it("has nothing for an undefined override", () => {
    expect(cleanOverride(undefined)).toBeUndefined();
  });

  it("collapses whitespace in a plain reason", () => {
    expect(cleanOverride("  the   owner\nok ")).toBe("the owner ok");
  });

  it("sorts and de-duplicates steps, de-duplicates rules, drops a blank rules list and cleans the reason", () => {
    expect(cleanOverride([{ steps: [4, 2, 4], rules: ["R19", "R19"], reason: "  a   b " }])).toEqual([
      { steps: [2, 4], rules: ["R19"], reason: "a b" },
    ]);
    expect(cleanOverride([{ steps: [3], rules: [], reason: " fine " }])).toEqual([{ steps: [3], reason: "fine" }]);
  });

  it("leaves an empty list empty", () => {
    expect(cleanOverride([])).toEqual([]);
  });
});

describe("serializeOverride", () => {
  it("stores a plain reason as is", () => {
    expect(serializeOverride("owner said it is fine")).toBe("owner said it is fine");
  });

  it("stores a list as JSON and round-trips through parseStoredOverride", () => {
    const list = [
      { steps: [3, 1, 3], rules: ["R17", "R17"], reason: "  a   b " },
      { steps: [2], reason: " c " },
    ];
    const stored = serializeOverride(list);
    expect(stored).toBe(JSON.stringify(list));
    expect(parseStoredOverride(stored)).toEqual([
      { steps: [1, 3], rules: ["R17"], reason: "a b" },
      { steps: [2], reason: "c" },
    ]);
  });
});

describe("resolveOverride", () => {
  it("has nothing to cover when there are no refusals and no override", () => {
    expect(resolveOverride([], undefined, { strict: true })).toEqual({ error: null, covered: [] });
    expect(resolveOverride([], undefined, { strict: false })).toEqual({ error: null, covered: [] });
  });

  it("allows a plain reason with no refusals in both modes, and an unused list only when not strict", () => {
    expect(resolveOverride([], "owner did it", { strict: true })).toEqual({ error: null, covered: [] });
    expect(resolveOverride([], "owner did it", { strict: false })).toEqual({ error: null, covered: [] });
    expect(resolveOverride([], [{ steps: [2], reason: "owner did it" }], { strict: false })).toEqual({ error: null, covered: [] });
  });

  it("refuses a list naming steps when nothing was refused, in strict mode only", () => {
    const r = resolveOverride([], [{ steps: [2, 4], reason: "owner did it" }], { strict: true });
    expect(r.error).toContain("nothing was refused");
    expect(r.error).toContain("step 2, 4");
  });

  it("covers every finding with a list and keeps one reason's findings together", () => {
    const f2a = finding(2, "R17", "first");
    const f2b = finding(2, "R17", "second");
    const f4 = finding(4, "R19", "third");
    const r = resolveOverride([f2a, f2b, f4], [
      { steps: [2], reason: "two is fine" },
      { steps: [4], reason: "four is fine" },
    ], { strict: true });
    expect(r).toEqual({
      error: null,
      covered: [
        { reason: "two is fine", findings: [f2a, f2b] },
        { reason: "four is fine", findings: [f4] },
      ],
    });
  });

  it("covers findings on one step with a plain reason", () => {
    const fs = [finding(3, "R19", "a"), finding(3, "R19", "b")];
    expect(resolveOverride(fs, "owner said it is fine", { strict: true })).toEqual({
      error: null,
      covered: [{ reason: "owner said it is fine", findings: fs }],
    });
  });

  it("refuses a plain reason when the refusals are on more than one step", () => {
    const fs = [finding(2, "R17"), finding(4, "R19")];
    const r = resolveOverride(fs, "owner said it is fine", { strict: false });
    expect(r.error).toContain("can't cover refusals on steps 2, 4");
    expect("uncovered" in r ? r.uncovered : undefined).toEqual(fs);
  });

  it("names the step a list leaves uncovered", () => {
    const coveredFinding = finding(2, "R17");
    const leftOut = finding(3, "R19", "missing");
    const r = resolveOverride([coveredFinding, leftOut], [{ steps: [2], reason: "two is fine" }], { strict: false });
    expect(r.error).toContain("step 3 (R19) isn't covered");
    expect("uncovered" in r ? r.uncovered : undefined).toEqual([leftOut]);
  });

  it("refuses an entry naming a step with no refusal in strict mode, and ignores it when not strict", () => {
    const fs = [finding(2, "R17")];
    const entries = [
      { steps: [2], reason: "two is fine" },
      { steps: [3], reason: "three is fine" },
    ];
    const strict = resolveOverride(fs, entries, { strict: true });
    expect(strict.error).toContain("step 3 matches nothing");
    expect(resolveOverride(fs, entries, { strict: false })).toEqual({
      error: null,
      covered: [{ reason: "two is fine", findings: fs }],
    });
  });

  it("refuses an entry naming a rule that is not on that step in strict mode", () => {
    const fs = [finding(2, "R17")];
    const entries = [
      { steps: [2], reason: "two is fine" },
      { steps: [2], rules: ["R19"], reason: "extra is fine" },
    ];
    const r = resolveOverride(fs, entries, { strict: true });
    expect(r.error).toContain("names R19 on step 2");
    expect(resolveOverride(fs, entries, { strict: false })).toEqual({
      error: null,
      covered: [{ reason: "two is fine", findings: fs }],
    });
  });
});

describe("uncoveredLines", () => {
  it("is just the error when nothing is left uncovered", () => {
    expect(uncoveredLines({ error: "No override covers these refusals." })).toBe("No override covers these refusals.");
    expect(uncoveredLines({ error: "No override covers these refusals.", uncovered: [] })).toBe("No override covers these refusals.");
  });

  it("adds one line per uncovered step under the error", () => {
    const r = {
      error: "Your override covers step 2; step 3 (R19) and step 5 (R17) aren't covered, so they stay refused.",
      uncovered: [finding(3, "R19", "a"), finding(5, "R17", "b")],
    };
    expect(uncoveredLines(r)).toBe(`${r.error}\n- Step 3: a.\n- Step 5: b.`);
  });
});
