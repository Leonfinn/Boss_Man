// BOS-2877: a queued check's time limit is per finished step, with a hard cap, so a slow host is not mistaken for a stuck check.
import { describe, expect, it } from "vitest";
import { CHECK_CAP_FACTOR, finishesStep, stepLimitMs } from "../src/check-clock.js";

const MIN = 60_000;

describe("finishesStep", () => {
  it("sees PASS, FAIL and SKIP lines, also after other output in the chunk", () => {
    expect(finishesStep("PASS  typecheck @boss-man/server\n")).toBe(true);
    expect(finishesStep("      tests: 3m, still running\nFAIL  x (exit 1)\n")).toBe(true);
    expect(finishesStep("SKIP  heavy phase\n")).toBe(true);
  });
  it("ignores progress lines and words inside a line", () => {
    expect(finishesStep("      tests related to server: 6m, still running\n")).toBe(false);
    expect(finishesStep("the PASS  was logged\n")).toBe(false);
    expect(finishesStep("PASSING\n")).toBe(false);
  });
});

describe("stepLimitMs", () => {
  it("gives the whole per-step limit early in the check", () => {
    expect(stepLimitMs({ now: 10 * MIN, slotTakenAt: 0, limitMs: 30 * MIN })).toBe(30 * MIN);
  });
  it("keeps going past the old single limit when steps finish (the 19:14 case: 31 minutes in)", () => {
    expect(stepLimitMs({ now: 31 * MIN, slotTakenAt: 0, limitMs: 30 * MIN })).toBe(29 * MIN); // the cap (60 min) is 29 min away, so more than the old single limit allowed
  });
  it("cuts the step limit to what is left of the hard cap", () => {
    const cap = CHECK_CAP_FACTOR * 30 * MIN;
    expect(stepLimitMs({ now: cap - 5 * MIN, slotTakenAt: 0, limitMs: 30 * MIN })).toBe(5 * MIN);
    expect(stepLimitMs({ now: cap + MIN, slotTakenAt: 0, limitMs: 30 * MIN })).toBe(0);
  });
});
