// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { SpendReport, type SpendData, type SpendRow } from "../src/pages/SpendReport";

// BOS-2194: the page itself, with the server's answer stubbed: the period and split choices, the error line, and the CSV.

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const row = (date: string, agent: string, feature: string, project: string, micros: number, tickets = 1): SpendRow => ({
  date,
  agentId: agent,
  agent,
  featureId: feature === "No feature" ? null : feature,
  feature,
  projectId: project,
  project,
  tickets,
  micros,
});
const answer = (n: number): SpendData => {
  const days = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 10, 21 - (n - 1 - i))).toISOString().slice(0, 10));
  const last = days.at(-1)!;
  const rows = [row(last, "Ann", "Search", "Site", 3_000_000, 2), row(last, "Bob", "No feature", "Docs", 1_000_000)];
  return { timeZone: "UTC", days, rows, totalMicros: 4_000_000 };
};

let respond: (url: string) => { status: number; body: unknown };
beforeEach(() => {
  respond = (url) => ({ status: 200, body: answer(Number(new URL(url, "http://x").searchParams.get("days"))) });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const r = respond(url);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Spend page", () => {
  it("redraws the bars when the period changes and the table when the split changes", async () => {
    const { container } = render(<SpendReport company={company} />);
    await waitFor(() => expect(container.querySelectorAll(".dbar")).toHaveLength(30));
    expect(within(screen.getByRole("table")).getByText("Ann")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(container.querySelectorAll(".dbar")).toHaveLength(7));
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    await waitFor(() => expect(container.querySelectorAll(".dbar")).toHaveLength(90));
    fireEvent.click(screen.getByRole("button", { name: "By feature" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("No feature")).toBeTruthy();
    expect(within(table).queryByText("Ann")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "By project" }));
    expect(within(screen.getByRole("table")).getByText("Docs")).toBeTruthy();
  });

  it("By model: a table with plan use and pay-as-you-go, and a CSV with a model column (BOS-2401)", async () => {
    const m = { runs: 2, inputTokens: 1500, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 };
    respond = (url) => {
      const base = answer(Number(new URL(url, "http://x").searchParams.get("days")));
      const day = base.days.at(-1)!;
      const modelDays = [
        { date: day, model: "opus", micros: 3_000_000, planMicros: 2_000_000, payMicros: 1_000_000, ...m },
        { date: day, model: "Unknown model", micros: 1_000_000, planMicros: 0, payMicros: 1_000_000, ...m },
      ];
      return { status: 200, body: { ...base, models: modelDays.map((d) => ({ ...d, date: "" })), modelDays } };
    };
    const { container } = render(<SpendReport company={company} />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "By model" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("opus")).toBeTruthy();
    expect(within(table).getByText("Unknown model")).toBeTruthy();
    expect(within(table).getByText("75%")).toBeTruthy();
    expect(within(table).getAllByText("1,500").length).toBe(2);
    expect(container.querySelectorAll(".dbar .seg.blue").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(container.querySelectorAll(".dbar")).toHaveLength(7));
    expect(within(screen.getByRole("table")).getByText("opus")).toBeTruthy();
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => ((blob = b), "blob:x"));
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const lines = (await blob!.text()).trim().split("\r\n");
    expect(lines[0]).toBe("date,model,runs,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,plan_usd,pay_as_you_go_usd,cost_usd");
    expect(lines[1]).toContain(",opus,2,1500,20,3,4,2.0000,1.0000,3.0000");
    fireEvent.click(screen.getByRole("button", { name: "By agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect((await blob!.text()).split("\r\n")[0]).toBe("date,agent,feature,project,tickets,cost_usd");
  });

  it("shows the costliest tickets as links with their share, and follows the period (BOS-2370)", async () => {
    respond = (url) => {
      const n = Number(new URL(url, "http://x").searchParams.get("days"));
      const top = [
        { ticketId: "t1", ref: "BOS-7", title: "Fix the thing", state: "in_progress", feature: "Search", micros: 3_000_000, runs: 4 },
        { ticketId: null, ref: null, title: "Not on a ticket", state: null, feature: null, micros: 1_000_000, runs: 0 },
      ];
      return { status: 200, body: { ...answer(n), topTickets: n === 7 ? top.slice(0, 1) : top } };
    };
    render(<SpendReport company={company} />);
    const heading = await screen.findByRole("heading", { name: "Costliest tickets" });
    const table = within(heading.parentElement!).getByRole("table");
    const link = within(table).getByRole("link", { name: "Fix the thing" });
    expect(link.getAttribute("href")).toBe("#/tickets/t1");
    expect(within(table).getByText("75%")).toBeTruthy();
    expect(within(table).getByText("Not on a ticket").closest("a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    // The old rows vanish while the loader shows, so wait for the new period's table itself.
    expect(await screen.findByRole("link", { name: "Fix the thing" })).toBeTruthy();
    expect(screen.queryByText("Not on a ticket")).toBeNull();
  });

  it("downloads a CSV whose rows add up to the table's total", async () => {
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => ((blob = b), "blob:x"));
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<SpendReport company={company} />);
    await screen.findByRole("table");
    const total = within(screen.getByRole("table")).getAllByText("$4.00");
    expect(total.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const lines = (await blob!.text()).trim().split("\r\n");
    expect(lines[0]).toBe("date,agent,feature,project,tickets,cost_usd");
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).reduce((n, l) => n + Number(l.split(",").at(-1)), 0)).toBeCloseTo(4);
  });

  // BOS-2432: the comparison with the previous period, through the page, for each period and split.
  const withPrev = (n: number, previousTotal: number) => {
    const base = answer(n);
    const day = base.days.at(-1)!;
    const m = { runs: 2, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const modelDays = [{ date: day, model: "opus", micros: 3_000_000, planMicros: 0, payMicros: 3_000_000, ...m }];
    return {
      ...base,
      models: modelDays.map((d) => ({ ...d, date: "" })),
      modelDays,
      previous: {
        days: n,
        totalMicros: previousTotal,
        agents: [{ key: "Ann", name: "Ann", micros: 2_000_000 }, { key: "Zed", name: "Zed", micros: 2_000_000 }],
        features: [{ key: "Search", name: "Search", micros: 1_500_000 }, { key: "Old feature", name: "Old feature", micros: 2_000_000 }],
        projects: [{ key: "Site", name: "Site", micros: 6_000_000 }, { key: "Old site", name: "Old site", micros: 1_000_000 }],
        models: [{ key: "opus", name: "opus", micros: 1_500_000 }, { key: "Gone model", name: "Gone model", micros: 2_000_000 }],
      },
    };
  };
  const cellsOf = (name: string) => Array.from(within(screen.getByRole("table")).getByText(name).closest("tr")!.querySelectorAll("td")).map((c) => c.textContent);

  it("shows the headline, the previous column and the change for 7, 30 and 90 days and every split (BOS-2432)", async () => {
    respond = (url) => {
      const n = Number(new URL(url, "http://x").searchParams.get("days"));
      return { status: 200, body: withPrev(n, 2_000_000) };
    };
    render(<SpendReport company={company} />);
    for (const n of [30, 7, 90]) {
      if (n !== 30) fireEvent.click(screen.getByRole("button", { name: `${n} days` }));
      await waitFor(() => expect(screen.getByTestId("spend-headline").textContent).toContain(`Up 100% on the previous ${n} days`));
      expect(screen.getByTestId("spend-headline").textContent).toContain("($2.00)");
      expect(screen.getByRole("columnheader", { name: `Previous ${n} days` })).toBeTruthy();
      expect(screen.getByRole("columnheader", { name: "vs previous" })).toBeTruthy();
    }
    // 90 days is now selected: agents, then each other split.
    expect(cellsOf("Ann").join("|")).toContain("$2.00|+$1.00 (+50%)");
    expect(cellsOf("Zed").slice(1, 4)).toEqual(["$0.00", "0%", "$2.00"]);
    expect(cellsOf("Zed")).toContain("−$2.00 (−100%)");
    expect(cellsOf("Bob")).toContain("new");
    fireEvent.click(screen.getByRole("button", { name: "By feature" }));
    expect(cellsOf("Search")).toContain("+$1.50 (+100%)");
    expect(cellsOf("Old feature")).toContain("−$2.00 (−100%)");
    expect(cellsOf("No feature")).toContain("new");
    fireEvent.click(screen.getByRole("button", { name: "By project" }));
    expect(cellsOf("Site")).toContain("−$3.00 (−50%)");
    expect(cellsOf("Old site")).toContain("−$1.00 (−100%)");
    expect(cellsOf("Docs")).toContain("new");
    fireEvent.click(screen.getByRole("button", { name: "By model" }));
    expect(screen.getByRole("columnheader", { name: "Previous 90 days" })).toBeTruthy();
    expect(cellsOf("opus")).toContain("+$1.50 (+100%)");
    expect(cellsOf("Gone model")).toContain("−$2.00 (−100%)");
  });

  it("says nothing was spent before, with no percentage, when the previous period is empty (BOS-2432)", async () => {
    respond = (url) => {
      const n = Number(new URL(url, "http://x").searchParams.get("days"));
      return { status: 200, body: { ...withPrev(n, 0), previous: { ...withPrev(n, 0).previous, agents: [] } } };
    };
    render(<SpendReport company={company} />);
    await waitFor(() => expect(screen.getByTestId("spend-headline").textContent).toContain("Nothing spent in the previous 30 days"));
    expect(screen.getByTestId("spend-headline").textContent).not.toContain("%");
    expect(cellsOf("Ann")).toContain("new");
  });

  it("says why when the load fails, and keeps the CSV button off with nothing to export", async () => {
    respond = () => ({ status: 500, body: { error: "boom" } });
    render(<SpendReport company={company} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the spend");
    expect((screen.getByRole("button", { name: "Download CSV" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers Retry on a failed load and shows the spend once the retry works", async () => {
    respond = () => ({ status: 500, body: { error: "boom" } });
    render(<SpendReport company={company} />);
    await screen.findByRole("alert");
    respond = (url) => ({ status: 200, body: answer(Number(new URL(url, "http://x").searchParams.get("days"))) });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("table");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
