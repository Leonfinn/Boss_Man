import { describe, expect, it } from "vitest";
import { pastWaitLine, type PastWait } from "../src/pages/settings/System";

const base: PastWait = { id: "a", startedAt: "2026-11-23T20:26:00Z", kind: "update", endedAt: null, endOk: null, endTitle: null, swapTries: [], events: [] };

describe("pastWaitLine (BOS-2408)", () => {
  it("says a hold with no end is still going", () => {
    expect(pastWaitLine(base)).toBe("still going");
  });
  it("counts failed swap tries and noted moments", () => {
    const w: PastWait = { ...base, endedAt: "2026-11-23T20:48:00Z", endTitle: "Runners updated", swapTries: [{ slug: "x", n: 1, at: "t", outcome: "failed" }, { slug: "x", n: 2, at: "t", outcome: "recreated" }], events: [{ at: "t", text: "e" }] };
    expect(pastWaitLine(w)).toBe("Runners updated, 1 swap try failed, 1 noted moment");
  });
});
