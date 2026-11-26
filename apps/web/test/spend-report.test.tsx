// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpendChart, SpendTable, changeText, chartData, headlineText, stacksBy, toCsv, toModelCsv, totalsBy, withPrevious, type SpendData, type SpendModelRow, type SpendPrevious, type SpendRow } from "../src/pages/SpendReport";

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

// BOS-2401: the model split's chart data, CSV and previous-period rows.
const modelRow = (model: string, micros: number, extra: Partial<SpendModelRow> = {}): SpendModelRow => ({
  date: "2026-11-20",
  model,
  micros,
  planMicros: 0,
  payMicros: 0,
  runs: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...extra,
});

describe("chartData", () => {
  const modelDays = [modelRow("Nimbus-One", 1_000_000), modelRow("Orion-Mini", 2_500_000)];
  const data: SpendData = { timeZone: "UTC", days, rows: [row("2026-11-20", "Ann", 999)], totalMicros: 999, modelDays };

  it("returns the data unchanged for any split other than model", () => {
    expect(chartData(data, "agent")).toBe(data);
    expect(chartData(data, "feature")).toBe(data);
    expect(chartData(data, "project")).toBe(data);
  });

  it("turns each model day into a row named by the model, and totals them", () => {
    const out = chartData(data, "model");
    expect(out.rows.map((r) => [r.date, r.agent, r.feature, r.project, r.micros])).toEqual([
      ["2026-11-20", "Nimbus-One", "Nimbus-One", "Nimbus-One", 1_000_000],
      ["2026-11-20", "Orion-Mini", "Orion-Mini", "Orion-Mini", 2_500_000],
    ]);
    expect(out.totalMicros).toBe(3_500_000);
  });

  it("gives no rows and a total of 0 when there are no model days", () => {
    const bare: SpendData = { timeZone: "UTC", days, rows: [row("2026-11-20", "Ann", 5_000_000)], totalMicros: 5_000_000 };
    const out = chartData(bare, "model");
    expect(out.rows).toEqual([]);
    expect(out.totalMicros).toBe(0);
  });
});

describe("toModelCsv", () => {
  const header = "date,model,runs,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,plan_usd,pay_as_you_go_usd,cost_usd";
  const previous: SpendPrevious = {
    days: 7,
    totalMicros: 2_000_000,
    agents: [],
    features: [],
    projects: [],
    models: [{ key: "Nimbus-One", name: "Nimbus-One", micros: 2_000_000 }],
  };

  it("writes its header, runs and tokens, and money to four dollars places", () => {
    const csv = toModelCsv([modelRow("Nimbus-One", 1_234_567, { planMicros: 1_000_000, payMicros: 234_567, runs: 5, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 56, cacheWriteTokens: 7 })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(header);
    expect(lines[1]).toBe("2026-11-20,Nimbus-One,5,1200,340,56,7,1.0000,0.2346,1.2346");
  });

  it("adds no previous column without a previous period", () => {
    expect(toModelCsv([modelRow("Nimbus-One", 500_000)]).split("\r\n")[0]).toBe(header);
  });

  it("adds the previous column, with 0.0000 for a model not in the previous list", () => {
    const lines = toModelCsv([modelRow("Nimbus-One", 500_000), modelRow("Fresh-Model", 250_000)], previous).split("\r\n");
    expect(lines[0]).toBe(`${header},previous_period_cost_usd`);
    expect(lines[1]).toBe("2026-11-20,Nimbus-One,1,0,0,0,0,0.0000,0.0000,0.5000,2.0000");
    expect(lines[2]).toBe("2026-11-20,Fresh-Model,1,0,0,0,0,0.0000,0.0000,0.2500,0.0000");
  });
});

describe("withPrevious", () => {
  const total = (key: string, name: string, micros: number) => ({ key, name, micros, share: 0, tone: "grey" });
  const current = [total("m-alpha", "Alpha", 3_000_000), total("m-beta", "Beta", 1_000_000)];
  const previous = [
    { key: "m-alpha", name: "Alpha", micros: 2_000_000 },
    { key: "m-gone", name: "Gone", micros: 4_000_000 },
    { key: "m-zero", name: "Zero", micros: 0 },
  ];

  it("gives each current row its previous money, 0 if it is not in the previous list", () => {
    expect(withPrevious(current, previous).slice(0, current.length).map((r) => [r.key, r.micros, r.before])).toEqual([
      ["m-alpha", 3_000_000, 2_000_000],
      ["m-beta", 1_000_000, 0],
    ]);
  });

  it("adds a previous-only row with money at 0 and gone, and leaves out one with no money", () => {
    const out = withPrevious(current, previous);
    expect(out.map((r) => r.key)).toEqual(["m-alpha", "m-beta", "m-gone"]);
    expect(out.find((r) => r.key === "m-gone")).toMatchObject({ micros: 0, before: 4_000_000, gone: true });
    expect(out.some((r) => r.key === "m-zero")).toBe(false);
  });

  it("gives every before 0 with no previous period", () => {
    const out = withPrevious(current, undefined);
    expect(out.map((r) => [r.key, r.before])).toEqual([["m-alpha", 0], ["m-beta", 0]]);
    expect(out.some((r) => r.gone)).toBe(false);
  });
});
