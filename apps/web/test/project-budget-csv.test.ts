import { describe, expect, it } from "vitest";
import { costliestTasksCsv, costliestTasksCsvName } from "../src/pages/ProjectBudget";

const t = (id: string, title: string, micros: number, planMicros: number) => ({ id, title, micros, planMicros });

describe("Project spend → Costliest tasks CSV (BOS-2543)", () => {
  it("writes one row per task in the page's order, as a rank and both figures in dollars to two places", () => {
    const csv = costliestTasksCsv([t("a1", "Add the CSV", 12_345_678, 4_000_000), t("b2", "Fix, the \"board\"", 999_999, 0)]);
    expect(csv.split("\r\n")).toEqual([
      "rank,task,ticket_id,pay_as_you_go_usd,subscriptions_at_list_usd,both_together_usd",
      "1,Add the CSV,a1,12.35,4.00,16.35",
      '2,"Fix, the ""board""",b2,1.00,0.00,1.00',
      "",
    ]);
  });

  it("rounds each figure as the page shows it, and adds the rounded pair", () => {
    // $0.004999 + $0.004999 is $0.01 on screen each, so both together is $0.01, not $0.00.
    const [, row] = costliestTasksCsv([t("x", "Tiny", 4_999, 4_999)]).split("\r\n");
    expect(row).toBe("1,Tiny,x,0.00,0.00,0.01");
  });

  it("names the file <project>-costliest-tasks-<date>.csv and tidies an awkward project name", () => {
    expect(costliestTasksCsvName("Development", new Date("2026-11-24T10:00:00Z"))).toBe("development-costliest-tasks-2026-11-24.csv");
    expect(costliestTasksCsvName(" My App! ", new Date("2026-01-02T10:00:00Z"))).toBe("my-app-costliest-tasks-2026-01-02.csv");
    expect(costliestTasksCsvName("!!!", new Date("2026-01-02T10:00:00Z"))).toBe("project-costliest-tasks-2026-01-02.csv");
  });
});
