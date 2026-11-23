// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectMonthlyTrend, type ProjectMonth } from "../src/components/ProjectMonthlyTrend";

// BOS-2369: the month-by-month chart and its table on a project's Budget page.
afterEach(cleanup);

const months: ProjectMonth[] = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"].map((month, i) => ({
  month,
  paygMicros: i * 1_000_000,
  planMicros: i === 5 ? 2_500_000 : 0,
  runs: i,
}));

describe("ProjectMonthlyTrend", () => {
  it("shows a table row per month with both kinds of spend and the runs", () => {
    render(<ProjectMonthlyTrend months={months} capMicros={null} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(7);
    const last = within(rows[6]!).getAllByRole("cell").map((c) => c.textContent);
    expect(last).toEqual(["$5.00", "$2.50", "5"]);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/last 6 months/);
    expect(screen.queryByText(/Monthly cap/)).toBeNull();
  });

  it("draws the monthly cap as a labelled line when one is set", () => {
    render(<ProjectMonthlyTrend months={months} capMicros={8_000_000} />);
    expect(screen.getByText("Monthly cap $8.00")).toBeTruthy();
  });

  it("says so instead of drawing empty bars when nothing was spent", () => {
    render(<ProjectMonthlyTrend months={months.map((m) => ({ ...m, paygMicros: 0, planMicros: 0, runs: 0 }))} capMicros={null} />);
    expect(screen.getByText(/No spend or runs on this project/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
