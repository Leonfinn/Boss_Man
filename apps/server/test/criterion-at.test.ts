// Which acceptance criterion an agent means, by number (1-based) or by its words (BOS-1245).
// `criterionAt` is a pure function, so no server or database is built here (see mcp-common-warnings.test.ts).
import { describe, expect, it } from "vitest";
import type { Criterion } from "@boss-man/shared";
import { criterionAt } from "../src/mcp-common.js";

const criteria: Criterion[] = [
  "Tests pass",
  { text: "Owner sees the new button", after: "merge" },
  "Diff is only the test file",
];

describe("criterionAt by number", () => {
  it("counts from 1, so 1 is the first criterion and 3 the third", () => {
    expect(criterionAt(criteria, 1)).toBe(0);
    expect(criterionAt(criteria, 3)).toBe(2);
  });

  it("has no range check of its own: 0 gives -1 and 4 gives 3; the caller checks", () => {
    // Pinned as today's behaviour: an out-of-range number is returned as-is (minus one) or below zero,
    // not rejected here. The caller is the one that validates the index against the criteria list.
    expect(criterionAt(criteria, 0)).toBe(-1);
    expect(criterionAt(criteria, 4)).toBe(3);
  });
});

describe("criterionAt by words", () => {
  it("matches a plain-string criterion and an after-merge one", () => {
    expect(criterionAt(criteria, "Owner sees the new button")).toBe(1);
  });

  it("ignores case and runs of spaces", () => {
    expect(criterionAt(criteria, "  tests   PASS ")).toBe(0);
  });

  it("ignores the note Boss Man appends to an after-merge criterion", () => {
    expect(
      criterionAt(criteria, "Owner sees the new button (checked after merge; don't fail the review on it)"),
    ).toBe(1);
  });

  it("gives -1 for words that match no criterion, including part of one", () => {
    expect(criterionAt(criteria, "Owner sees the new banner")).toBe(-1);
    expect(criterionAt(criteria, "Tests")).toBe(-1);
  });

  it("treats a number-looking string as words, so '2' gives -1", () => {
    // Turning "2" into the number 2 is `criterionArg`'s job, not this function's.
    expect(criterionAt(criteria, "2")).toBe(-1);
  });
});
