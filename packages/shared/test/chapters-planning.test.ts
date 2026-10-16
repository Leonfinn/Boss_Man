import { describe, expect, it } from "vitest";
import { chapterDue, planFirstByDefault, planningGuidance } from "../src/index.js";

describe("chapterDue", () => {
  const start = new Date("2026-10-01T00:00:00Z");
  const base = { startedAt: start, contextUsed: null, contextSize: null, rollRequestedAt: null };
  it("closes at 70% context, after 7 days, or when the owner asks", () => {
    expect(chapterDue(base, new Date("2026-10-07T23:59:00Z"))).toBeNull();
    expect(chapterDue(base, new Date("2026-10-08T00:00:00Z"))).toBe("age");
    expect(chapterDue({ ...base, contextUsed: 139_999, contextSize: 200_000 }, start)).toBeNull();
    expect(chapterDue({ ...base, contextUsed: 140_000, contextSize: 200_000 }, start)).toBe("context");
    expect(chapterDue({ ...base, contextUsed: 190_000, contextSize: 200_000, rollRequestedAt: start }, start)).toBe("owner");
  });
});

describe("graded planning", () => {
  it("asks for more planning as risk rises", () => {
    expect(planningGuidance("trivial")).toContain("no plan needed");
    expect(planningGuidance(null)).toContain("short plan");
    expect(planningGuidance("critical")).toContain("how you'd undo it");
    expect([planFirstByDefault("medium"), planFirstByDefault("high"), planFirstByDefault("critical")]).toEqual([false, true, true]);
  });
});
