// BOS-1339: silentStage decides whether a run that has posted nothing is left alone, asked for a
// status ("steer") or flagged. It is pure, so pin the exact boundaries here.
import { describe, expect, it } from "vitest";
import { silentStage } from "../src/services/progress.js";

const MIN = 60_000;
const limits = (silentSteerMinutes: number, silentFlagMinutes: number) => ({ silentSteerMinutes, silentFlagMinutes });

describe("silentStage with the default limits (steer 30 min, flag 60 min)", () => {
  const s = limits(30, 60);

  it("leaves a run alone at 0 ms and just under 30 minutes", () => {
    expect(silentStage(0, s)).toBe("ok");
    expect(silentStage(29 * MIN + 59_999, s)).toBe("ok");
  });

  it("asks for a status at exactly 30 minutes and just under 60", () => {
    expect(silentStage(30 * MIN, s)).toBe("steer");
    expect(silentStage(59 * MIN + 59_999, s)).toBe("steer");
  });

  it("flags at exactly 60 minutes and at 5 hours", () => {
    expect(silentStage(60 * MIN, s)).toBe("flag");
    expect(silentStage(5 * 60 * MIN, s)).toBe("flag");
  });
});

describe("silentStage when the steer and flag limits are the same", () => {
  it("flags at 45 minutes, because the flag is checked first", () => {
    expect(silentStage(45 * MIN, limits(45, 45))).toBe("flag");
  });

  it("leaves it alone just under the shared limit", () => {
    expect(silentStage(45 * MIN - 1, limits(45, 45))).toBe("ok");
  });
});

describe("silentStage when the flag limit is below the steer limit (steer 60, flag 30)", () => {
  it("flags at 40 minutes", () => {
    expect(silentStage(40 * MIN, limits(60, 30))).toBe("flag");
  });

  it("leaves 20 minutes alone, since it is under both limits", () => {
    expect(silentStage(20 * MIN, limits(60, 30))).toBe("ok");
  });
});

describe("silentStage with a negative silence (clock skew)", () => {
  it("is ok", () => {
    expect(silentStage(-1, limits(30, 60))).toBe("ok");
    expect(silentStage(-60 * MIN, limits(30, 60))).toBe("ok");
  });
});
