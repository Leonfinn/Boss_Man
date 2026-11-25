import { describe, expect, it } from "vitest";
import { compareLastMoved, isStalled, lastMovedLabel, lastMovedTitle } from "../src/feature-stall";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const tasks = (...states: string[]) => ({ items: states.map((state) => ({ state, outcome: null })) });

describe("compareLastMoved", () => {
  it("puts the longest quiet first and features with no tasks last", () => {
    const recent = { lastMovedAt: daysAgo(1), priority: 1 };
    const old = { lastMovedAt: daysAgo(9), priority: 1 };
    const none = { lastMovedAt: null, priority: 99 };
    expect([none, recent, old].sort(compareLastMoved)).toEqual([old, recent, none]);
  });
  it("breaks a tie by higher priority", () => {
    const a = { lastMovedAt: daysAgo(2), priority: 1 };
    const b = { lastMovedAt: daysAgo(2), priority: 5 };
    expect([a, b].sort(compareLastMoved)).toEqual([b, a]);
  });
});

describe("lastMovedLabel", () => {
  it("says today, days ago, or a dash", () => {
    expect(lastMovedLabel(daysAgo(0.2), NOW)).toBe("today");
    expect(lastMovedLabel(daysAgo(2.5), NOW)).toBe("2 d ago");
    expect(lastMovedLabel(null, NOW)).toBe("—");
  });
});

describe("lastMovedTitle", () => {
  it("says no tasks yet when nothing has moved", () => {
    expect(lastMovedTitle(null, NOW)).toBe("No tasks yet");
    expect(lastMovedTitle(undefined, NOW)).toBe("No tasks yet");
  });
  it("says the last task change and its age", () => {
    expect(lastMovedTitle(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("Last task change 3h ago");
    expect(lastMovedTitle(daysAgo(2.5), NOW)).toBe("Last task change 2d ago");
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
