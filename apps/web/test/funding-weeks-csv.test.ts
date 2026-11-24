import { describe, expect, it } from "vitest";
import { weeksFileName, weeksToCsvRows } from "../src/pages/Funding";

const w = (start: string, extra: object = {}) => ({ start, end: start, plans: [], spendMicros: 0, holds: [], ...extra });

describe("funding 8-week CSV rows", () => {
  it("lists weeks oldest first with peak use, reset count, spend and holds", () => {
    const rows = weeksToCsvRows([
      w("2026-11-16T00:00:00.000Z", {
        plans: [
          { window: "5h", resets: 4, peak: 0.92, limit: null },
          { window: "7d", resets: 1, peak: 0.4, limit: null },
        ],
        spendMicros: 12_500_000,
        holds: [
          { window: "5h", startedAt: "a", endedAt: "b", ms: 90 * 60_000 },
          { window: "5h", startedAt: "c", endedAt: null, ms: 30 * 60_000 },
        ],
      }),
      w("2026-11-09T00:00:00.000Z"),
    ]);
    expect(rows).toEqual([
      ["2026-11-09", "", 0, "0.00", 0, 0],
      ["2026-11-16", 92, 5, "12.50", 2, 120],
    ]);
  });

  it("names the file from the source and the day", () => {
    expect(weeksFileName("Claude Max (team)", new Date("2026-11-24T10:00:00Z"))).toBe("funding-claude-max-team-8-weeks-2026-11-24.csv");
  });
});
