// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MachineRecord, type MachineStatsView } from "../src/pages/settings/CheckWorkers";

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
