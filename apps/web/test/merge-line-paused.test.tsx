// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { healthLines } from "../src/components/DashboardPanels";
import { MergesStuckBanner, pausedSlotsText, pausedSummary, slowSummary, stuckSummary, type MergeHealthView } from "../src/components/MergesStuckBanner";

// R44: a deliberate pause (a server update waiting for a quiet machine) is its own state: reason, latest end, no alarm.

afterEach(cleanup);

const view: MergeHealthView = { waitingCount: 21, stuckCount: 0, line: { state: "paused", reason: "a server update", since: "2026-11-17T08:52:00Z", until: "2026-11-17T11:52:00Z", inUse: 2, slots: 5 } };

describe("merge line paused", () => {
  it("is neither stuck nor slow, and the slot line says new checks are paused", () => {
    expect(stuckSummary(view)).toBeNull();
    expect(slowSummary(view)).toBeNull();
    expect(pausedSlotsText(pausedSummary(view)!)).toBe("2 of 5 slots in use: new checks paused");
  });

  it("the banner names the reason and the latest end, with no time-to-clear estimate", () => {
    const { container } = render(<MergesStuckBanner stuck={null} slow={null} paused={pausedSummary(view)} companyId="c1" />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/Paused for a server update since \d\d:\d\d[^;]*; new checks start once it is done, by \d\d:\d\d[^,]* at the latest/);
    expect(text).toContain("2 of 5 slots in use: new checks paused");
    expect(text).not.toMatch(/slowly|stuck|to clear/);
    expect(screen.getByRole("status").getAttribute("data-merge-paused")).toBe("true");
  });

  it("the Dashboard Merges line is a calm warning, not stuck", () => {
    const line = healthLines({ health: {}, merges: view, stuck: null, slow: null, running: 0, companyId: "c1" }).find((l) => l.key === "merges")!;
    expect(line).toMatchObject({ tone: "warn", state: "Merges paused" });
  });
});
