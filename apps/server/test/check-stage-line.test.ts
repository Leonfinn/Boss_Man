import { describe, expect, it } from "vitest";
import { stageLine } from "../src/services/check-stage-line.js";

const t = (m: number) => new Date(Date.UTC(2026, 10, 19, 0, m));
const stages = (...s: Array<[string, number]>) => JSON.stringify(s.map(([name, seconds]) => ({ name, seconds })));

describe("stageLine (BOS-1938)", () => {
  it("names the three longest stages, folds the rest into other, and says how busy the machine was", () => {
    const line = stageLine(
      { stages: stages(["lint", 60], ["server tests", 960], ["shell tests", 360], ["web tests", 180], ["build", 120]), ranFull: true, busyAtStart: 2, startedAt: t(0), endedAt: t(28) },
      3,
    );
    expect(line).toBe("Full check, 28 min: server tests 16 min · shell tests 6 min · web tests 3 min · other 3 min. 2 of 3 slots busy when it started.");
  });

  it("calls a check that did not run the full one a quick check, with no other when there are three stages or fewer", () => {
    const line = stageLine({ stages: stages(["typecheck", 90], ["related tests", 120]), ranFull: false, busyAtStart: null, startedAt: null, endedAt: null }, 3);
    expect(line).toBe("Quick check, 4 min: related tests 2 min · typecheck 2 min.");
  });

  it("shows nothing for a job with no step times (before BOS-1923, or pruned)", () => {
    for (const raw of [null, "", "[]", "not json", "{}"]) {
      expect(stageLine({ stages: raw, ranFull: null, busyAtStart: 1, startedAt: t(0), endedAt: t(5) }, 3)).toBeNull();
    }
  });
});
