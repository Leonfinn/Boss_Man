// BOS-1866: the list-price table and the band a recorded cost must sit in.
import { describe, expect, it } from "vitest";
import { checkRunCost, expectedCostMicros, listPriceFor } from "../src/list-price.js";

const M = 1_000_000;

describe("listPriceFor", () => {
  it("knows current model ids, with or without a provider prefix", () => {
    expect(listPriceFor("claude-sonnet-5-5")?.input).toEqual({ lo: 2, hi: 2 });
    expect(listPriceFor("anthropic/claude-opus-5-5")?.output).toEqual({ lo: 20, hi: 20 });
    expect(listPriceFor("claude-opus-4-1")?.input).toEqual({ lo: 15, hi: 15 });
    expect(listPriceFor("claude-opus-4-8")?.input).toEqual({ lo: 5, hi: 5 });
    expect(listPriceFor("claude-fable-5-1")?.output).toEqual({ lo: 50, hi: 50 });
  });
  it("gives a bare alias the range of the family", () => {
    expect(listPriceFor("opus")?.input).toEqual({ lo: 4, hi: 5 });
  });
  it("has no price for other providers' models or none at all", () => {
    expect(listPriceFor("qwen3:8b")).toBeNull();
    expect(listPriceFor("default")).toBeNull();
    expect(listPriceFor(null)).toBeNull();
  });
});

describe("checkRunCost", () => {
  const tokens = { input: M, output: 100_000, cacheRead: 0, cacheWrite: 0 }; // sonnet 5.5: $3.00
  it("accepts a figure at list price and one within the band", () => {
    expect(expectedCostMicros("claude-sonnet-5-5", tokens)).toEqual({ lo: 3 * M, hi: 3 * M });
    expect(checkRunCost("claude-sonnet-5-5", tokens, 3 * M).status).toBe("ok");
    expect(checkRunCost("claude-sonnet-5-5", tokens, 5 * M).status).toBe("ok");
  });
  it("flags a figure over twice, or under half, of what the tokens cost", () => {
    expect(checkRunCost("claude-sonnet-5-5", tokens, 24 * M).status).toBe("out_of_band");
    expect(checkRunCost("claude-sonnet-5-5", tokens, 1 * M).status).toBe("out_of_band");
  });
  it("counts cache tokens inside a range, so heavy cache use is not flagged", () => {
    const heavy = { input: 10_000, output: 5_000, cacheRead: 5 * M, cacheWrite: 200_000 };
    const e = expectedCostMicros("claude-sonnet-5-5", heavy)!;
    expect(e.hi).toBeGreaterThan(e.lo);
    expect(checkRunCost("claude-sonnet-5-5", heavy, e.hi).status).toBe("ok");
  });
  it("skips, with a reason, what it cannot judge", () => {
    expect(checkRunCost("qwen3:8b", tokens, 24 * M)).toEqual({ status: "skipped", reason: "no_list_price" });
    expect(checkRunCost("claude-sonnet-5-5", tokens, 0)).toEqual({ status: "skipped", reason: "no_recorded_cost" });
    expect(checkRunCost("claude-sonnet-5-5", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 5 * M)).toEqual({ status: "skipped", reason: "no_tokens" });
    expect(checkRunCost("claude-sonnet-5-5", { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }, 10_000)).toEqual({ status: "skipped", reason: "too_small" });
  });
});
