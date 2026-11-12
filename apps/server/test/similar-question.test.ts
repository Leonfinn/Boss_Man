// BOS-1149: similarQuestion decides whether a new ask to the owner repeats one they already
// answered (BOS-123) without blocking a genuinely different question (BOS-175). Pure function.
import { describe, expect, it } from "vitest";
import { similarQuestion } from "../src/services/stale-requests.js";

describe("similarQuestion", () => {
  it("treats the same ask in a different case and spacing as the same one", () => {
    expect(similarQuestion("Approve the deploy?", "approve   THE deploy?")).toBe(true);
    // No 3+ letter words, so this only matches through the normalised-text check.
    expect(similarQuestion("OK ?", "ok   ?")).toBe(true);
  });

  it("treats punctuation-only differences as the same ask", () => {
    expect(similarQuestion("Approve, the deploy.", "Approve the deploy")).toBe(true);
    expect(similarQuestion("Approve the runner-rebuild?", "Approve the runner rebuild?")).toBe(true);
  });

  it("counts an overlap just above 60% of the shorter ask as similar", () => {
    const shorter = "approve deploy runner rebuild staging backup restore";
    const above = "approve deploy runner rebuild staging plus something";
    // 5 words shared, shorter ask has 7: 5/7 is about 71%.
    expect(similarQuestion(shorter, above)).toBe(true);
  });

  it("does not count an overlap just below 60% of the shorter ask as similar", () => {
    const shorter = "approve deploy runner rebuild staging backup restore";
    const below = "approve deploy runner rebuild alpha bravo charlie";
    // 4 words shared, shorter ask has 7: 4/7 is about 57%.
    expect(similarQuestion(shorter, below)).toBe(false);
  });

  it("counts an overlap of exactly 60% as similar", () => {
    expect(similarQuestion("approve deploy runner rebuild staging", "approve deploy runner alpha bravo")).toBe(true);
  });

  it("ignores one and two letter words when measuring overlap", () => {
    // Only "is", "to" and "an" are shared; if they counted this would be 3/4 similar.
    expect(similarQuestion("Deploy is to an?", "Rebuild is to an?")).toBe(false);
  });

  it("is not similar to an ask that has no words of 3+ letters, unless the text is identical", () => {
    expect(similarQuestion("ok?", "Approve the deploy?")).toBe(false);
    expect(similarQuestion("ok?", "no?")).toBe(false);
    expect(similarQuestion("ok?", "ok?")).toBe(true);
    expect(similarQuestion("ok?", "OK?")).toBe(true);
  });

  it("does not treat two genuinely different asks as a repeat", () => {
    // 2 words shared of 4 in the shorter ask: "approve" and "the".
    expect(similarQuestion("Approve the deploy of 10be777d?", "Approve the runner rebuild?")).toBe(false);
  });
});
