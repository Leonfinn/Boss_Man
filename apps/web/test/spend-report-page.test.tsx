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

  it("says why when the load fails, and keeps the CSV button off with nothing to export", async () => {
    respond = () => ({ status: 500, body: { error: "boom" } });
    render(<SpendReport company={company} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load the spend");
    expect((screen.getByRole("button", { name: "Download CSV" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
