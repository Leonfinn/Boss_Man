// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpendChart, SpendTable, changeText, headlineText, stacksBy, toCsv, totalsBy, type SpendData, type SpendRow } from "../src/pages/SpendReport";

// BOS-2194: the Spend page's totals, stacks, table and CSV.

afterEach(cleanup);

const row = (date: string, agent: string, micros: number, extra: Partial<SpendRow> = {}): SpendRow => ({
  date,
  agentId: `a-${agent}`,
  agent,
  featureId: "f1",
  feature: "Search box",
  projectId: "p1",
  project: "Site",
  tickets: 1,
  micros,
  ...extra,
});
const days = ["2026-11-19", "2026-11-20", "2026-11-21"];
const agents = ["Ann", "Bob", "Cat", "Dan", "Eve", "Fay", "Gus"];
// Seven agents, so the top five get a colour and two fall into "Other". Ann spends most.
const many: SpendData = {
  timeZone: "Europe/London",
  days,
  rows: agents.map((a, i) => row("2026-11-20", a, (7 - i) * 1_000_000)),
  totalMicros: 28_000_000,
};

describe("totalsBy", () => {
  it("ranks by money, gives the top 5 a colour and the rest grey, and shares sum to 1", () => {
    const t = totalsBy(many.rows, "agent");
    expect(t.map((x) => x.name)).toEqual(agents);
    expect(t.slice(0, 5).map((x) => x.tone)).toEqual(["blue", "green", "amber", "purple", "teal"]);
    expect(t.slice(5).map((x) => x.tone)).toEqual(["grey", "grey"]);
    expect(t.reduce((n, x) => n + x.share, 0)).toBeCloseTo(1);
  });

  it("splits by feature and shows spend with no feature as its own line", () => {
    const rows = [row("2026-11-20", "Ann", 3_000_000), row("2026-11-20", "Ann", 1_000_000, { featureId: null, feature: "No feature" })];
    expect(totalsBy(rows, "feature").map((x) => [x.name, x.micros])).toEqual([["Search box", 3_000_000], ["No feature", 1_000_000]]);
  });
});

describe("stacksBy", () => {
  it("folds everything past the top 5 into one Other part per day, and keeps empty days", () => {
    const s = stacksBy(many, "agent");
    expect(s.map((d) => d.micros)).toEqual([0, 28_000_000, 0]);
    expect(s[1]!.parts.map((p) => p.name)).toEqual(["Ann", "Bob", "Cat", "Dan", "Eve", "Other"]);
    expect(s[1]!.parts.at(-1)!.micros).toBe(3_000_000);
  });
});

describe("toCsv", () => {
  it("writes a header, one row per line, dollars, and quotes what needs it", () => {
    const csv = toCsv([row("2026-11-20", 'Ann, "the" CEO', 1_234_500, { tickets: 2 })]);
    expect(csv).toBe('date,agent,feature,project,tickets,cost_usd\r\n2026-11-20,"Ann, ""the"" CEO",Search box,Site,2,1.2345\r\n');
  });

  it("stops a name that starts like a formula from running in a spreadsheet", () => {
    expect(toCsv([row("2026-11-20", "=HYPERLINK(1)", 1)]).split("\r\n")[1]).toContain("'=HYPERLINK(1)");
  });
});

describe("the chart and table", () => {
  it("shows the table with shares and the total, and one bar per day", () => {
    render(<SpendTable data={many} by="agent" />);
    const rows = screen.getAllByRole("row");
    expect(rows).toHaveLength(7 + 2);
    expect(within(rows[1]!).getByText("$7.00")).toBeTruthy();
    expect(within(rows[1]!).getByText("25%")).toBeTruthy();
    expect(within(rows.at(-1)!).getByText("$28.00")).toBeTruthy();
  });

  it("says there was no spend, in words, when the period is empty", () => {
    const empty: SpendData = { timeZone: "UTC", days, rows: [], totalMicros: 0 };
    const { container } = render(<SpendChart data={empty} by="agent" />);
    expect(screen.getByText("No spend in the last 3 days")).toBeTruthy();
    expect(container.querySelectorAll(".dbar")).toHaveLength(3);
  });

  it("names Other in the legend when there are more than five", () => {
    render(<SpendChart data={many} by="agent" />);
    expect(within(screen.getByRole("list")).getByText("Other")).toBeTruthy();
  });
});

// BOS-2432: the change against the previous period of the same length.
describe("previous period", () => {
  const previous = {
    days: 7,
    totalMicros: 10_000_000,
    agents: [
      { key: "a-Ann", name: "Ann", micros: 5_000_000 },
      { key: "a-Zed", name: "Zed", micros: 5_000_000 },
    ],
    features: [],
    projects: [],
    models: [],
  };
  const data: SpendData = { timeZone: "UTC", days, rows: [row("2026-11-20", "Ann", 8_000_000), row("2026-11-20", "Bob", 1_000_000)], totalMicros: 9_000_000, previous };

  it("words and signs the change, and handles new, dropped and empty", () => {
    expect(changeText(8_000_000, 5_000_000)).toBe("+$3.00 (+60%)");
    expect(changeText(1_000_000, 5_000_000)).toBe("−$4.00 (−80%)");
    expect(changeText(1_000_000, 0)).toBe("new");
    expect(changeText(0, 0)).toBe("no change");
    expect(headlineText(12_300_000, previous)).toBe("Up 23% on the previous 7 days");
    expect(headlineText(5_900_000, previous)).toBe("Down $4.10 on the previous 7 days");
    expect(headlineText(5_000_000, { ...previous, totalMicros: 0 })).toBe("Nothing spent in the previous 7 days");
  });

  it("shows a dropped agent at $0 and a new one as new", () => {
    render(<SpendTable data={data} by="agent" />);
    expect(within(screen.getByText("Zed").closest("tr")!).getByText("−$5.00 (−100%)")).toBeTruthy();
    expect(within(screen.getByText("Bob").closest("tr")!).getByText("new")).toBeTruthy();
    expect(within(screen.getByText("Ann").closest("tr")!).getByText("+$3.00 (+60%)")).toBeTruthy();
  });

  it("adds a previous period cost column to the CSV only when there is a previous period", () => {
    const lines = toCsv(data.rows, previous, "agent").split("\r\n");
    expect(lines[0]).toBe("date,agent,feature,project,tickets,cost_usd,previous_period_cost_usd");
    expect(lines[1]).toBe("2026-11-20,Ann,Search box,Site,1,8.0000,5.0000");
    expect(lines[2]).toMatch(/,0\.0000$/);
  });
});
