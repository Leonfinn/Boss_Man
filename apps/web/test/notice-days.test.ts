import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay } from "../src/notice-days";

// Local times (no "Z"), so the test holds in any time zone.
const NOW = new Date(2026, 10, 24, 15, 0, 0);
const at = (m: number, d: number, h: number) => new Date(2026, m, d, h).toISOString();

describe("dayLabel", () => {
  it("names today and yesterday, then weekday and date", () => {
    expect(dayLabel(new Date(2026, 10, 24, 1), NOW)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 23, 23), NOW)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 10, 22, 9), NOW)).toBe("Sun 22 Nov");
  });
  it("adds the year for another year", () => {
    expect(dayLabel(new Date(2025, 11, 31), NOW)).toBe("Wed 31 Dec 2025");
  });
});

describe("groupByDay", () => {
  const rows = [
    { id: "a", createdAt: at(10, 24, 14), readAt: null },
    { id: "b", createdAt: at(10, 24, 9), readAt: "x" },
    { id: "c", createdAt: at(10, 23, 20), readAt: null },
    { id: "d", createdAt: at(10, 20, 8), readAt: null },
    { id: "e", createdAt: at(10, 23, 1), readAt: null },
  ];
  it("groups by local day, keeping a day that is split in one group", () => {
    const g = groupByDay(rows, NOW);
    expect(g.map((x) => x.label)).toEqual(["Today", "Yesterday", "Fri 20 Nov"]);
    expect(g[1]!.items.map((r) => r.id)).toEqual(["c", "e"]);
  });
  it("lists only the unread ids of each day", () => {
    const g = groupByDay(rows, NOW);
    expect(g[0]!.unreadIds).toEqual(["a"]);
    expect(g[1]!.unreadIds).toEqual(["c", "e"]);
  });
  it("puts a row with an unreadable time under Earlier", () => {
    expect(groupByDay([{ id: "z", createdAt: "nope" }], NOW)[0]!.label).toBe("Earlier");
  });
});
