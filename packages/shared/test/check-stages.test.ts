import { describe, expect, it } from "vitest";
import { createStageTracker } from "../src/check-log.js";

describe("createStageTracker (BOS-1923)", () => {
  it("reads full-check step times and check-quick step gaps, across chunk splits, and says the full check ran", () => {
    const t = createStageTracker(0);
    t.feed("check-all: waiting for a free check slot\nPASS  merge che", 5_000);
    t.feed("ck\ncheck-all: slot taken, running the checks\n", 20_000);
    t.feed("FAIL  typecheck (exit 2)\n      FAIL  test/a.test.ts\n", 50_000);
    t.feed("\u001b[32mPASS\u001b[0m  related tests\ncheck-all: step in-memory-state took 7s (exit 0, at 10:00:00 UTC)\n", 110_000);
    expect(t.result()).toEqual({ full: true, stages: [{ name: "merge check", seconds: 20 }, { name: "typecheck", seconds: 30 }, { name: "related tests", seconds: 60 }, { name: "in-memory-state", seconds: 7 }] });
  });

  it("a quick-only run is not full, and the list is capped", () => {
    const t = createStageTracker(0);
    for (let i = 0; i < 100; i++) t.feed(`PASS  step ${i}\n`, i * 1000);
    expect(t.result().full).toBe(false);
    expect(t.result().stages).toHaveLength(60);
  });
});
