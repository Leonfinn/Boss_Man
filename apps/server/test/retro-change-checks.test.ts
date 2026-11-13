// The reason and optional wiki link given when a retro change is applied, kept or reverted (BOS-1294).
// checkChangeReason and checkChangeLink are pure functions, so no server or database is built here
// (see criterion-at.test.ts).
import { describe, expect, it } from "vitest";
import { CHANGE_REASON_MAX, RetroError, checkChangeLink, checkChangeReason } from "../src/services/retro.js";

function retroError(fn: () => unknown): RetroError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RetroError);
    return e as RetroError;
  }
  throw new Error("expected the check to throw a RetroError");
}

describe("checkChangeReason", () => {
  it("refuses an absent, empty or blank reason with a 422 and says it can't be empty", () => {
    for (const reason of [undefined, "", "   "]) {
      const e = retroError(() => checkChangeReason(reason));
      expect(e.status).toBe(422);
      expect(e.message).toMatch(/reason can't be empty/);
    }
  });

  it("tidies runs of spaces and line breaks down to single spaces", () => {
    expect(checkChangeReason("  too   many\n words ")).toBe("too many words");
  });

  it("accepts exactly CHANGE_REASON_MAX characters and refuses one more", () => {
    const atLimit = "a".repeat(CHANGE_REASON_MAX);
    expect(checkChangeReason(atLimit)).toBe(atLimit);

    const e = retroError(() => checkChangeReason("a".repeat(CHANGE_REASON_MAX + 1)));
    expect(e.status).toBe(422);
    expect(e.message).toMatch(new RegExp(`${CHANGE_REASON_MAX} characters or fewer`));
  });

  it("checks the length after tidying, not before", () => {
    // 498 letters in three runs, with a 3-space and a 2-space gap between them: 503 characters as typed,
    // but tidying collapses the gaps to one space each, so it comes to exactly CHANGE_REASON_MAX and passes.
    const raw = `${"a".repeat(166)}   ${"a".repeat(166)}  ${"a".repeat(166)}`;
    expect(raw).toHaveLength(CHANGE_REASON_MAX + 3);
    const tidy = checkChangeReason(raw);
    expect(tidy).toHaveLength(CHANGE_REASON_MAX);
    expect(tidy).toBe(`${"a".repeat(166)} ${"a".repeat(166)} ${"a".repeat(166)}`);
  });
});

describe("checkChangeLink", () => {
  it("gives null for an absent, empty or blank link, with no error", () => {
    expect(checkChangeLink(undefined)).toBeNull();
    expect(checkChangeLink("")).toBeNull();
    expect(checkChangeLink("  ")).toBeNull();
  });

  it("gives a slug back with the surrounding spaces trimmed", () => {
    expect(checkChangeLink(" product/decisions/why ")).toBe("product/decisions/why");
  });

  it("allows a section after the slug", () => {
    expect(checkChangeLink("product/decisions/why#Skipped: playbooks")).toBe(
      "product/decisions/why#Skipped: playbooks",
    );
  });

  it("refuses anything that is not a wiki slug, optionally with a section, with a 422", () => {
    const bad = [
      "https://example.com/x",
      "/leading-slash",
      "has space",
      `product/decisions/why#${"x".repeat(201)}`,
      "product/decisions/why#line\nbreak",
      "a".repeat(401),
    ];
    for (const link of bad) {
      const e = retroError(() => checkChangeLink(link));
      expect(e.status).toBe(422);
      expect(e.message).toMatch(/wiki page address/);
    }
  });
});
