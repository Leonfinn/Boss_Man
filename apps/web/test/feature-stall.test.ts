import { describe, expect, it } from "vitest";
import { isStalled, lastMovedLabel } from "../src/feature-stall";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const tasks = (...states: string[]) => ({ items: states.map((state) => ({ state, outcome: null })) });

describe("lastMovedLabel", () => {
  it("says today, days ago, or a dash", () => {
    expect(lastMovedLabel(daysAgo(0.2), NOW)).toBe("today");
    expect(lastMovedLabel(daysAgo(2.5), NOW)).toBe("2 d ago");
    expect(lastMovedLabel(null, NOW)).toBe("—");
  });
});

describe("isStalled", () => {
  const base = { status: "in_progress", lastMovedAt: daysAgo(4), tickets: tasks("done", "in_progress") };
  it("marks part-done in-progress work quiet for over 3 days", () => {
    expect(isStalled(base, NOW)).toBe(true);
  });
  it("not when recent, not in progress, none done, all done, or no tasks", () => {
    expect(isStalled({ ...base, lastMovedAt: daysAgo(2) }, NOW)).toBe(false);
    expect(isStalled({ ...base, status: "planned" }, NOW)).toBe(false);
    expect(isStalled({ ...base, tickets: tasks("backlog", "in_progress") }, NOW)).toBe(false);
    expect(isStalled({ ...base, tickets: tasks("done", "done") }, NOW)).toBe(false);
    expect(isStalled({ ...base, lastMovedAt: null, tickets: tasks() }, NOW)).toBe(false);
  });
});
