import { describe, expect, it } from "vitest";
import { countHits, dayStart, findSpots, firstOnOrAfter, spotIndex, splitHits, stepSpot } from "../src/chat-find";

describe("chat find helper (BOS-2411)", () => {
  it("matches case-insensitively and splits text around each match", () => {
    expect(splitHits("Deploy the deploy script", "DEPLOY")).toEqual([
      { text: "Deploy", hit: true },
      { text: " the ", hit: false },
      { text: "deploy", hit: true },
      { text: " script", hit: false },
    ]);
  });

  it("treats the box text as plain words, not a pattern", () => {
    expect(countHits(["a.b a+b axb"], "a.b")).toBe(1);
    expect(countHits(["cost (USD) [x]"], "(usd)")).toBe(1);
    expect(countHits(["anything"], "   ")).toBe(0);
  });

  it("counts matches only in the parts it is given (the words, not the markup)", () => {
    // "[docs](https://example.com/docs)" shows as the words "docs"; the address is not a part.
    const msgs = [{ id: "m1", parts: ["see ", "docs"] }, { id: "m2", parts: ["none"] }, { id: "m3", parts: ["docs docs"] }];
    expect(findSpots(msgs, "docs")).toEqual([
      { id: "m1", n: 0 },
      { id: "m3", n: 0 },
      { id: "m3", n: 1 },
    ]);
    expect(findSpots(msgs, "")).toEqual([]);
  });

  it("steps to the next and previous match and wraps; no current match starts at the newest", () => {
    const spots = [{ id: "a", n: 0 }, { id: "b", n: 0 }, { id: "b", n: 1 }];
    expect(stepSpot(spots, null, 1)).toEqual({ id: "b", n: 1 });
    expect(stepSpot(spots, { id: "b", n: 1 }, 1)).toEqual({ id: "a", n: 0 });
    expect(stepSpot(spots, { id: "a", n: 0 }, -1)).toEqual({ id: "b", n: 1 });
    expect(stepSpot([], null, 1)).toBeNull();
    expect(spotIndex(spots, { id: "b", n: 0 })).toBe(1);
    expect(spotIndex(spots, { id: "zz", n: 0 })).toBe(-1);
  });

  it("reads a date field value as the start of that local day, and refuses anything else", () => {
    expect(dayStart("2026-11-05")).toBe(new Date(2026, 10, 5).getTime());
    expect(dayStart("")).toBeNull();
    expect(dayStart("2026-02-31")).toBeNull();
    expect(dayStart("5 Nov")).toBeNull();
  });

  it("finds the first message on or after a day, or none when every message is older", () => {
    const at = (d: number) => ({ id: `m${d}`, createdAt: new Date(2026, 10, d, 9).toISOString() });
    const items = [at(2), at(3), at(7)];
    expect(firstOnOrAfter(items, new Date(2026, 10, 3).getTime())?.id).toBe("m3");
    expect(firstOnOrAfter(items, new Date(2026, 10, 5).getTime())?.id).toBe("m7");
    expect(firstOnOrAfter(items, new Date(2026, 10, 8).getTime())).toBeNull();
  });
});
