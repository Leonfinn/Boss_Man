// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckLine, CheckWorkers, lineToCsv, machinesToCsvRows, type CheckLineView, type MachineStatsView } from "../src/pages/settings/CheckWorkers";
import { stubFetchByUrl } from "./stub-fetch";

// BOS-2519: "Download CSV" for the machines' 7 days and for the check line's 7 days.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stats = (machine: string, extra: Partial<MachineStatsView> = {}): MachineStatsView => ({ machine, total: 10, passed: 8, failed: 1, stuck: 1, medianSeconds: 840, longestSeconds: 3000, recent: [], ...extra });
const line: CheckLineView = {
  days: [
    { date: "2026-11-22", quick: 0, full: 0, merge: 0 },
    { date: "2026-11-23", quick: 4, full: 1, merge: 2 },
  ],
  kinds: [
    { kind: "quick", total: 4, cancelled: 1, medianWaitSeconds: 1200, longestWaitSeconds: 7200, medianRunSeconds: 300 },
    { kind: "full", total: 0, cancelled: 0, medianWaitSeconds: null, longestWaitSeconds: null, medianRunSeconds: null },
  ],
  busiestHours: [],
  waitingNow: 0,
  oldestWaitSeconds: null,
  timeZone: "UTC",
};

function capture() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  URL.createObjectURL = ((b: Blob) => (blobs.push(b), "blob:x")) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    names.push(this.download);
  };
  return { blobs, names, restore: () => (HTMLAnchorElement.prototype.click = click) };
}

describe("machinesToCsvRows", () => {
  it("leaves a figure with no value empty, not 0", () => {
    expect(
      machinesToCsvRows([
        { name: "Company runner", connected: true, stats: stats("runner") },
        { name: "Spare, big", connected: false, stats: stats("w1", { total: 0, passed: 0, failed: 0, stuck: 0, medianSeconds: null, longestSeconds: null }) },
        { name: "New one", connected: true, stats: undefined },
      ]),
    ).toEqual([
      ["Company runner", "yes", 10, 8, 1, 1, 840, 3000],
      ["Spare, big", "no", 0, 0, 0, 0, "", ""],
      ["New one", "yes", 0, 0, 0, 0, "", ""],
    ]);
  });
});

describe("lineToCsv", () => {
  it("writes the days, a blank line, then the kinds with their own header", () => {
    expect(lineToCsv(line).split("\r\n")).toEqual([
      "date,quick,full,merge,total",
      "2026-11-22,0,0,0,0",
      "2026-11-23,4,1,2,7",
      "",
      "kind,checks,cancelled,median_wait_seconds,longest_wait_seconds,median_run_seconds",
      "quick,4,1,1200,7200,300",
      "full,0,0,,,",
      "",
    ]);
  });
});

describe("Download CSV buttons", () => {
  it("the check line fold saves check-line-7-days-<date>.csv", async () => {
    const cap = capture();
    render(<CheckLine line={line} />);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(cap.names[0]).toMatch(/^check-line-7-days-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((await cap.blobs[0]!.text()).startsWith("date,quick,full,merge,total\r\n")).toBe(true);
    cap.restore();
  });

  it("the machines button saves one row for the runner and one per worker", async () => {
    const cap = capture();
    stubFetchByUrl({
      "/api/companies": [],
      "/api/host-facts": {},
      "/api/settings/check-workers/stats": [stats("runner"), stats("w1", { total: 0, passed: 0, failed: 0, stuck: 0, medianSeconds: null, longestSeconds: null })],
      "/api/settings/check-workers/line": { ...line, kinds: [] },
    });
    const w = { id: "w1", name: "Spare machine", enabled: true, connected: false, slots: 2, reportedSlots: 2, limit: 2, checkThreads: null, checkMemoryMb: null, imageCommit: null, toolchain: null, lastSeenAt: null, companies: [], reason: null };
    render(<CheckWorkers workers={[w]} maxSlots={8} reload={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
    expect(cap.names[0]).toMatch(/^check-workers-7-days-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((await cap.blobs[0]!.text()).split("\r\n")).toEqual([
      "machine,connected,checks,passed,failed,stuck,median_seconds,longest_seconds",
      "Company runner,yes,10,8,1,1,840,3000",
      "Spare machine,no,0,0,0,0,,",
      "",
    ]);
    cap.restore();
  });
});
