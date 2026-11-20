import { afterEach, describe, expect, it, vi } from "vitest";
import { actionTime, smSummary } from "../src/components/ScrumMasterLog";

afterEach(() => {
  vi.useRealTimers();
});

// The function formats with the runner's own locale and time zone, so the checks below
// pin which parts appear (a bare time on the same day, the day and month on another)
// rather than an exact string, and use instants far enough from local midnight that
// they fall on the same (or different) local day whatever the runner's zone is.
describe("actionTime", () => {
  it("shows just the time for an action earlier the same day", () => {
    const shown = actionTime("2026-11-20T00:30:00Z", new Date("2026-11-20T00:45:00Z"));
    expect(shown).toMatch(/^\d{1,2}:\d{2}(\s*[AP]M)?$/i);
    expect(shown).not.toMatch(/[A-Za-z]{3,}/);
  });

  it("adds the day and month for an action on another day", () => {
    const shown = actionTime("2026-11-18T00:30:00Z", new Date("2026-11-20T00:45:00Z"));
    expect(shown).toMatch(/\d{1,2}:\d{2}(\s*[AP]M)?/i);
    expect(shown).toMatch(/[A-Za-z]{3,}/);
  });

  it("reads the clock when no now is given", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T00:45:00Z"));
    expect(actionTime("2026-11-20T00:30:00Z")).toBe(actionTime("2026-11-20T00:30:00Z", new Date()));
  });
});

describe("smSummary", () => {
  it("says so plainly when the log is empty", () => {
    expect(smSummary([])).toBe("0 actions · all settled");
  });

  it("counts one action", () => {
    expect(smSummary([{ issueKey: null, status: null, label: null }])).toBe("1 action · all settled");
  });

  it("counts several actions", () => {
    expect(
      smSummary([
        { issueKey: null, status: null, label: null },
        { issueKey: null, status: null, label: null },
        { issueKey: null, status: null, label: null },
      ]),
    ).toBe("3 actions · all settled");
  });

  it("counts warnings rather than rows once the log has issues", () => {
    expect(
      smSummary([
        { issueKey: "a", status: "settled", label: null },
        { issueKey: "b", status: "settled", label: null },
        { issueKey: null, status: null, label: null },
      ]),
    ).toBe("2 warnings · all settled");
  });

  it("says how many warnings are still open", () => {
    expect(
      smSummary([
        { issueKey: "a", status: "open", label: null },
        { issueKey: "b", status: "open", label: null },
        { issueKey: "c", status: "settled", label: null },
      ]),
    ).toBe("3 warnings · 2 open");
  });

  it("says 1 warning, not 1 warnings", () => {
    expect(smSummary([{ issueKey: "a", status: "open", label: null }])).toBe("1 warning · 1 open");
    expect(smSummary([{ issueKey: "a", status: "settled", label: null }])).toBe("1 warning · all settled");
  });

  it("takes the day from a warning's label", () => {
    expect(
      smSummary([
        { issueKey: "a", status: "settled", label: "2nd warning on BOS-149 today" },
        { issueKey: "b", status: "settled", label: "1st warning on BOS-149 today" },
        { issueKey: "c", status: "settled", label: "3rd warning on BOS-149 today" },
      ]),
    ).toBe("3 warnings today · all settled");
    expect(
      smSummary([
        { issueKey: "a", status: "open", label: "2nd warning on BOS-149 on 26 Oct" },
        { issueKey: "b", status: "settled", label: null },
      ]),
    ).toBe("2 warnings on 26 Oct · 1 open");
  });

  it("leaves the day out when no label says one", () => {
    expect(
      smSummary([
        { issueKey: "a", status: "settled", label: "Review looks stuck" },
        { issueKey: "b", status: "settled", label: null },
      ]),
    ).toBe("2 warnings · all settled");
  });
});
