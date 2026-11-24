// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckLine, CheckWorkers, type CheckLineView } from "../src/pages/settings/CheckWorkers";

// BOS-2436: the "Check line, last 7 days" fold above the machines.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const days = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"].map((date) => ({ date, quick: 0, full: 0, merge: 0 }));
const line: CheckLineView = {
  days: days.map((d, i) => (i === 6 ? { ...d, quick: 4, merge: 2 } : d)),
  kinds: [
    { kind: "quick", total: 4, cancelled: 1, medianWaitSeconds: 1200, longestWaitSeconds: 7200, medianRunSeconds: 300 },
    { kind: "full", total: 0, cancelled: 0, medianWaitSeconds: null, longestWaitSeconds: null, medianRunSeconds: null },
    { kind: "merge", total: 2, cancelled: 0, medianWaitSeconds: 3600, longestWaitSeconds: 5400, medianRunSeconds: 2400 },
  ],
  busiestHours: [
    { hour: 9, checks: 3 },
    { hour: 23, checks: 2 },
  ],
  waitingNow: 2,
  oldestWaitSeconds: 5400,
  timeZone: "Europe/London",
};

describe("CheckLine", () => {
  it("shows waiting now, per-kind waits and run times, days and the busiest hours", () => {
    render(<CheckLine line={line} />);
    expect(screen.getByText("Check line, last 7 days")).toBeTruthy();
    expect(screen.getByTestId("check-line-now").textContent).toBe("Waiting now: 2 checks, the oldest for 90 min.");
    const rows = [...screen.getByTestId("check-line-kinds").querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent));
    expect(rows).toEqual([
      ["Quick", "4", "20 min", "120 min", "5 min", "1"],
      ["Full", "0", "", "", "", "0"],
      ["Merge", "2", "60 min", "90 min", "40 min", "0"],
    ]);
    const dayRows = screen.getByTestId("check-line-days").querySelectorAll("tbody tr");
    expect(dayRows).toHaveLength(7);
    expect([...dayRows[6]!.querySelectorAll("td")].map((td) => td.textContent)).toEqual(["Mon 23 Nov", "4", "0", "2"]);
    expect(screen.getByTestId("check-line-hours").textContent).toBe("Busiest hours (checks queued, Europe/London time): 09:00–10:00 (3) · 23:00–00:00 (2)");
  });

  it("says so when there were no checks", () => {
    render(<CheckLine line={{ ...line, days, kinds: line.kinds.map((k) => ({ ...k, total: 0, cancelled: 0 })), busiestHours: [], waitingNow: 0, oldestWaitSeconds: null }} />);
    expect(screen.getByTestId("check-line-empty").textContent).toBe("No checks in the last 7 days");
    expect(screen.getByTestId("check-line-now").textContent).toBe("Nothing waiting now.");
    expect(screen.queryByTestId("check-line-kinds")).toBeNull();
  });
});

describe("CheckWorkers", () => {
  it("asks for the line in the browser's zone and shows it above the machines", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("/line") ? line : []), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CheckWorkers workers={[]} maxSlots={8} reload={() => {}} companyId="c-1" />);
    const fold = await screen.findByTestId("check-line");
    expect(fold.compareDocumentPosition(screen.getByTestId("check-runner-record")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const asked = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/line"))!;
    expect(asked).toContain(`tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
    expect(asked).toContain("companyId=c-1");
  });

  it("shows a load error with Retry when the line fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (String(url).includes("/line") ? new Response("{}", { status: 500, headers: { "content-type": "application/json" } }) : new Response("[]", { status: 200, headers: { "content-type": "application/json" } }))));
    render(<CheckWorkers workers={[]} maxSlots={8} reload={() => {}} />);
    expect(await screen.findByText(/Couldn't load the check line's last 7 days/)).toBeTruthy();
  });
});
