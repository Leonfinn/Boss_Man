import { expect, it } from "vitest";
import { dayIn, lastSevenDays, summarizeWeek, type WeekRow } from "../src/services/notification-week.js";

const NOW = new Date("2026-11-23T01:30:00Z");
const row = (o: Partial<Omit<WeekRow, "createdAt" | "pushedAt">> & { createdAt: string; pushedAt?: string }): WeekRow => ({
  id: o.id ?? "n1",
  createdAt: new Date(o.createdAt),
  pushedAt: o.pushedAt ? new Date(o.pushedAt) : null,
  demotedBy: o.demotedBy ?? null,
  pushError: o.pushError ?? null,
  agentId: o.agentId ?? null,
  agentName: o.agentName ?? null,
  link: o.link ?? "#/runs/1",
  title: o.title ?? "t",
});

it("groups by day in the owner's time zone, not UTC", () => {
  // 01:30 UTC on the 23rd is still the 22nd in New York.
  expect(dayIn("America/New_York", NOW)).toBe("2026-11-22");
  expect(lastSevenDays("America/New_York", NOW).at(-1)).toBe("2026-11-22");
  expect(lastSevenDays("UTC", NOW)).toHaveLength(7);
});

it("counts pushed, quiet-hours, cap and failed per day and in total", () => {
  const s = summarizeWeek(
    [
      row({ id: "a", createdAt: "2026-11-23T00:10:00Z", pushedAt: "2026-11-23T00:10:01Z", agentId: "x", agentName: "Ann" }),
      row({ id: "b", createdAt: "2026-11-22T10:00:00Z", demotedBy: "quiet hours", agentId: "x", agentName: "Ann" }),
      row({ id: "c", createdAt: "2026-11-22T11:00:00Z", demotedBy: "cap", agentId: "y", agentName: "Bo" }),
      row({ id: "d", createdAt: "2026-11-22T12:00:00Z", pushError: "502 from ntfy", link: "#/notifications/d", agentId: "y", agentName: "Bo" }),
      row({ id: "old", createdAt: "2026-11-01T12:00:00Z", agentId: "z", agentName: "Old" }),
    ],
    "UTC",
    NOW,
  );
  expect(s.totals).toEqual({ notices: 4, pushed: 1, quiet: 1, cap: 1, failed: 1 });
  expect(s.days.find((d) => d.day === "2026-11-22")).toMatchObject({ notices: 3, quiet: 1, cap: 1, failed: 1, pushed: 0 });
  expect(s.topAgents.map((a) => [a.name, a.notices, a.pushed])).toEqual([["Ann", 2, 1], ["Bo", 2, 0]]);
  expect(s.lastFailure).toMatchObject({ id: "d", error: "502 from ntfy", link: "#/notifications/d" });
});

it("an empty week has zero totals and no failure", () => {
  const s = summarizeWeek([], "UTC", NOW);
  expect(s.totals.notices).toBe(0);
  expect(s.days).toHaveLength(7);
  expect(s.lastFailure).toBeNull();
});
