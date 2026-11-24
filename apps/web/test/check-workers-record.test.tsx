// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckWorkers, MachineRecord, type MachineStatsView } from "../src/pages/settings/CheckWorkers";

// BOS-2373: the 7-day line and the "Last 10 checks" fold under each machine.
afterEach(cleanup);

const stats: MachineStatsView = {
  machine: "w1",
  total: 42,
  passed: 38,
  failed: 3,
  stuck: 1,
  medianSeconds: 840,
  longestSeconds: 3000,
  recent: [{ id: "j1", ticketId: "t-uuid", ref: "BOS-7", title: "A ticket", kind: "pre_review", scope: "quick", result: "failed", seconds: 60, endedAt: "2026-11-23T10:00:00Z" }],
};

describe("CheckWorkers with a failed stats load", () => {
  it("keeps the worker list and buttons working and shows the load error with Retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/stats") ? new Response("{}", { status: 500, headers: { "content-type": "application/json" } }) : new Response("[]", { status: 200, headers: { "content-type": "application/json" } }))));
    const w = { id: "w1", name: "Spare machine", enabled: true, connected: true, slots: 2, reportedSlots: 2, limit: 2, checkThreads: null, checkMemoryMb: null, imageCommit: null, toolchain: null, lastSeenAt: null, companies: [], reason: null };
    render(<CheckWorkers workers={[w]} maxSlots={8} reload={() => {}} />);
    expect(await screen.findByText(/Couldn't load the machines' last 7 days/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("MachineRecord", () => {
  it("shows the counts, median and a linked ticket ref in the fold", () => {
    render(<MachineRecord stats={stats} />);
    expect(screen.getByTestId("machine-record").textContent).toContain("7 days: 42 checks · 38 passed · 3 failed · 1 stuck · median 14 min");
    expect(screen.getByRole("link", { name: "BOS-7" }).getAttribute("href")).toBe("#/tickets/t-uuid");
    expect(screen.getByText("Last 1 checks")).toBeTruthy();
  });
  it("says so when a machine has no checks", () => {
    render(<MachineRecord stats={undefined} />);
    expect(screen.getByTestId("machine-record").textContent).toBe("No checks in the last 7 days");
  });
});
