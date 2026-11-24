// @vitest-environment jsdom
// BOS-2425: the Workflow report's "Where tickets wait" section.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Workflow } from "../src/pages/Workflow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const H = 3_600_000;
const row = (state: string, tickets: number, p50Ms: number | null, p90Ms: number | null, share: number | null) => ({ state, tickets, p50Ms, p90Ms, share });
const base = { days: 14, costBasis: "estimate", byRole: [], byAgent: [], handoffs: [], features: [], sizes: [], sizeNotes: [] };

function show(stateWaits: object) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...base, stateWaits }), { status: 200, headers: { "content-type": "application/json" } })));
  render(<Workflow company={{ id: "c1", name: "Acme" } as Company} />);
}

describe("Workflow: where tickets wait", () => {
  it("shows a row per state, the slowest tickets linked, and how many were left out", async () => {
    show({
      rows: [row("in_progress", 3, 5 * H, 9 * H, 0.5), row("checking", 2, 30 * 60_000, H, 0.05), row("in_review", 3, 4 * H, 6 * H, 0.3), row("blocked", 0, null, null, 0), row("merging", 3, 2 * H, 3 * H, 0.15)],
      slowest: [{ id: "t1", ref: "BOS-9", title: "Slow one", totalMs: 20 * H, longest: "in_review", longestMs: 8 * H }],
      timed: 3,
      leftOut: 2,
    });
    const h = await screen.findByRole("heading", { name: "Where tickets wait" });
    const section = h.closest("section")!;
    const rows = within(section).getAllByRole("row").slice(1);
    expect(rows.map((r) => Array.from(r.querySelectorAll("td")).map((c) => c.textContent))).toEqual([
      ["In progress", "3", "5.0h", "9.0h", "50%"],
      ["Being checked", "2", "30m", "1.0h", "5%"],
      ["In review", "3", "4.0h", "6.0h", "30%"],
      ["Blocked", "0", "–", "–", "0%"],
      ["Merging", "3", "2.0h", "3.0h", "15%"],
    ]);
    expect(within(section).getByRole("link", { name: "BOS-9" }).getAttribute("href")).toBe("#/tickets/t1");
    expect(section.textContent).toContain("20h in all · longest in review (8.0h)");
    expect(section.textContent).toContain("2 finished tickets are left out");
  });

  it("says so when nothing finished has a full history", async () => {
    show({ rows: [], slowest: [], timed: 0, leftOut: 1 });
    const h = await screen.findByRole("heading", { name: "Where tickets wait" });
    const section = h.closest("section")!;
    expect(within(section).queryByRole("table")).toBeNull();
    expect(section.textContent).toContain("No finished ticket with a full history in this period.");
    expect(section.textContent).toContain("1 finished ticket is left out: its history");
  });
});
