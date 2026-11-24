// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCsv } from "../src/csv";
import { CheckLine, CheckWorkers, MACHINES_CSV_HEAD, lineToCsv, machinesToCsvRows, type CheckLineView, type MachineStatsView } from "../src/pages/settings/CheckWorkers";
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

describe("seven days and three kinds; names with a comma or a leading =", () => {
  it("gives 7 day rows with totals, then the 3 kind rows in seconds", () => {
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ date: `2026-11-${17 + i}`, quick: i, full: 1, merge: 2 }));
    const kinds: CheckLineView["kinds"] = [
      { kind: "quick", total: 21, cancelled: 2, medianWaitSeconds: 10, longestWaitSeconds: 99, medianRunSeconds: 300 },
      { kind: "full", total: 7, cancelled: 0, medianWaitSeconds: 20, longestWaitSeconds: 40, medianRunSeconds: 1800 },
      { kind: "merge", total: 14, cancelled: 1, medianWaitSeconds: null, longestWaitSeconds: null, medianRunSeconds: 2400 },
    ];
    const rows = lineToCsv({ ...line, days, kinds }).split("\r\n");
    expect(rows).toHaveLength(1 + 7 + 1 + 1 + 3 + 1);
    expect(rows.slice(1, 8).map((r) => r.split(",")[4])).toEqual(["3", "4", "5", "6", "7", "8", "9"]);
    expect(rows.slice(10, 13)).toEqual(["quick,21,2,10,99,300", "full,7,0,20,40,1800", "merge,14,1,,,2400"]);
  });

  it("quotes a name holding a comma and guards one starting with =", () => {
    const csv = buildCsv(MACHINES_CSV_HEAD, machinesToCsvRows([{ name: "Rack, shelf 2", connected: true, stats: undefined }, { name: "=SUM(A1)", connected: true, stats: undefined }]));
    const lines = csv.split("\r\n");
    expect(lines[1]!.startsWith('"Rack, shelf 2",yes')).toBe(true);
    expect(lines[2]!.startsWith("'=SUM(A1),yes")).toBe(true);
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
