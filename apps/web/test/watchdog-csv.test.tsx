// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WATCHDOG } from "@boss-man/shared";
import type { Company } from "../src/api";
import { Watchdog } from "../src/pages/Settings";
import { flagsToCsv, problemCounts } from "../src/pages/settings/Watchdog";

// BOS-2541: "Download CSV" beside "Hide ones that cleared by themselves" saves the flags shown in the test result.

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const flag = (n: number, over: Record<string, unknown> = {}) => ({ ticketId: `t${n}`, ref: `BOS-${n}`, title: `Ticket ${n}`, rule: "unassigned", firstAt: "2026-10-25T12:00:00.000Z", handOffs: 1, verdict: "still open", ...over });
const flags = [flag(1), flag(2, { verdict: "cleared within 30 min", title: "=SUM(A1), \"x\"" }), flag(3, { rule: "stale_in_progress", handOffs: 0 })];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

let blobs: Blob[] = [];
beforeEach(() => {
  blobs = [];
  URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return "blob:x"; });
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.includes("backtest")
    ? { from: "a", to: "b", flags, scrumMasterWakes: 1, busiestHourWakes: 1, wouldTripCap: false, caveats: [] }
    : { settings: DEFAULT_WATCHDOG, scrumMaster: null, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("problemCounts", () => {
  it("counts flags and cleared ones per rule, and puts the rule with more flags first", () => {
    const list = [
      flag(1, { rule: "unassigned" }),
      flag(2, { rule: "unassigned", verdict: "cleared within 30 min" }),
      flag(3, { rule: "stale_review", verdict: "cleared within 30 min" }),
      flag(4, { rule: "stale_review" }),
      flag(5, { rule: "stale_review" }),
    ];
    expect(problemCounts(list as never)).toEqual([
      { rule: "stale_review", flags: 3, cleared: 1 },
      { rule: "unassigned", flags: 2, cleared: 1 },
    ]);
  });

  it("gives an empty list when there are no flags at all", () => {
    expect(problemCounts([])).toEqual([]);
  });
});

describe("flagsToCsv", () => {
  it("writes a header and one row per flag, with the table's words, an ISO time and guarded formulas", () => {
    const lines = flagsToCsv(flags as never).split("\r\n");
    expect(lines[0]).toBe("Ticket,Title,Problem,First seen,Outcome,Hand-offs");
    expect(lines[1]).toBe("BOS-1,Ticket 1,nobody is assigned,2026-10-25T12:00:00.000Z,still open,1");
    expect(flagsToCsv(flags as never)).toContain("\"'=SUM(A1), \"\"x\"\"\"");
  });
});

describe("Watchdog test result Download CSV", () => {
  it("appears only once there are flags and saves exactly the rows left after the hide switch", async () => {
    render(<Watchdog company={company} />);
    await screen.findByText("Run the test");
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run the test" }));
    await screen.findByText(/it would have raised 3 flags/);
    fireEvent.click(screen.getByLabelText("Hide ones that cleared by themselves"));
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(blobs).toHaveLength(1);
    const text = await blobs[0]!.text();
    expect(text.trim().split("\r\n")).toHaveLength(3); // header + 2 rows (the cleared one is hidden)
    expect(text).not.toContain("SUM(A1)");
  });
});
