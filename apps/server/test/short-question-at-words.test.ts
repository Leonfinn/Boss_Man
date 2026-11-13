import { describe, expect, it } from "vitest";
import { atWords } from "../src/services/closed-notice.js";
import { shortQuestion } from "../src/services/merge-queue.js";

describe("shortQuestion", () => {
  it("returns a short one-line question unchanged, trimmed at both ends", () => {
    expect(shortQuestion("  Merge this?  ")).toBe("Merge this?");
  });

  it("gives only the first non-blank line, skipping blank and space-only lines", () => {
    expect(shortQuestion("First\nSecond\nThird")).toBe("First");
    expect(shortQuestion("\n   \n\t\n  Real line  \nlater")).toBe("Real line");
  });

  it("treats \\r\\n line endings like \\n", () => {
    expect(shortQuestion("First\r\nSecond")).toBe("First");
    expect(shortQuestion("\r\n  \r\nReal\r\nlater")).toBe("Real");
  });

  it("gives an empty string for an empty or all-blank question", () => {
    expect(shortQuestion("")).toBe("");
    expect(shortQuestion(" \n  \r\n\t")).toBe("");
  });

  it("keeps a line of exactly 140 characters", () => {
    const line = "a".repeat(140);
    expect(shortQuestion(line)).toBe(line);
  });

  it("cuts a 141-character line to 139 characters plus an ellipsis", () => {
    const out = shortQuestion("a".repeat(141));
    expect(out).toBe(`${"a".repeat(139)}…`);
    expect(out).toHaveLength(140);
  });

  it("honours a custom max and trims a space just before the cut", () => {
    const long = "word ".repeat(40);
    const out = shortQuestion(long, 80);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);

    // Character 79 (index 78) is a space: the cut must drop it.
    const spaced = `${"a".repeat(78)} ${"b".repeat(30)}`;
    const trimmed = shortQuestion(spaced, 80);
    expect(trimmed).toBe(`${"a".repeat(78)}…`);
    expect(trimmed.endsWith(" …")).toBe(false);
  });
});

describe("atWords", () => {
  it("does not pad the day and drops the seconds", () => {
    expect(atWords(new Date("2026-11-08T13:47:44Z"))).toBe("8 Nov, 13:47 UTC");
  });

  it("pads hours and minutes to 2 digits", () => {
    expect(atWords(new Date("2026-11-08T05:07:00Z"))).toBe("8 Nov, 05:07 UTC");
  });

  it("is always UTC at month and day edges", () => {
    expect(atWords(new Date("2026-10-31T23:30:00Z"))).toBe("31 Oct, 23:30 UTC");
    expect(atWords(new Date("2026-12-01T00:00:00Z"))).toBe("1 Dec, 00:00 UTC");
  });
});
