// BOS-2645: adviceOf reads the advice block off a decision's context, and nothing else.
import { describe, expect, it } from "vitest";
import { adviceOf, type Advice } from "../src/services/decisions.js";

describe("adviceOf", () => {
  it("returns the same advice object the context carries", () => {
    const advice: Advice = { state: "asking", note: "Which one is cheaper?", askedAt: "2026-11-26T04:00:00.000Z" };
    const context = { type: "question", advice };
    expect(adviceOf(context)).toBe(advice);
  });

  it("returns undefined for a context with no advice", () => {
    expect(adviceOf({ type: "question" })).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(adviceOf(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(adviceOf(undefined)).toBeUndefined();
  });
});
