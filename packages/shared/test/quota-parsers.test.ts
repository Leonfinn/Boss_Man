import { describe, expect, it } from "vitest";
import { currentReportSamples, normaliseUtilization, parseClaudeRateLimit, parseCodexRateLimits, windowHasReset, toDate, windowLabel } from "../src/quota.js";

describe("windowHasReset (BOS-1409)", () => {
  const reset = new Date("2026-11-12T10:00:00.000Z");
  it("is true once the window's reset time has passed, at the moment of reset too", () => {
    expect(windowHasReset(reset, new Date("2026-11-12T10:00:00.000Z"))).toBe(true);
    expect(windowHasReset(reset, new Date("2026-11-12T10:00:01.000Z"))).toBe(true);
  });

  it("is false while the window is still running, and for a window with no reset time", () => {
    expect(windowHasReset(reset, new Date("2026-11-12T09:59:59.000Z"))).toBe(false);
    expect(windowHasReset(reset, new Date("2026-11-11T09:00:00.000Z"))).toBe(false);
    expect(windowHasReset(null, new Date("2026-11-12T10:00:01.000Z"))).toBe(false);
  });
});

describe("toDate", () => {
  it("reads unix seconds and unix milliseconds as the same instant", () => {
    const seconds = toDate(1792177800);
    const millis = toDate(1792177800000);
    expect(seconds).toBeInstanceOf(Date);
    expect(millis).toBeInstanceOf(Date);
    expect(seconds!.getTime()).toBe(millis!.getTime());
  });

  it("reads an ISO string", () => {
    expect(toDate("2026-10-17T14:00:00.000Z")?.toISOString()).toBe("2026-10-17T14:00:00.000Z");
  });

  it("gives null for unreadable values", () => {
    expect(toDate("")).toBeNull();
    expect(toDate("nope")).toBeNull();
    expect(toDate(Number.NaN)).toBeNull();
    expect(toDate(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("normaliseUtilization", () => {
  it("keeps fractions at or below 1", () => {
    expect(normaliseUtilization(0.5)).toBe(0.5);
    expect(normaliseUtilization(1)).toBe(1);
    expect(normaliseUtilization(1.4)).toBe(1);
  });

  it("reads values above 1.5 as percentages, capped at 1", () => {
    expect(normaliseUtilization(80)).toBe(0.8);
    expect(normaliseUtilization(150)).toBe(1);
  });

  it("gives null for values it cannot read", () => {
    expect(normaliseUtilization(-1)).toBeNull();
    expect(normaliseUtilization(Number.NaN)).toBeNull();
    expect(normaliseUtilization("0.5")).toBeNull();
  });
});

describe("parseClaudeRateLimit", () => {
  const rateLimit = (overrides: Record<string, unknown> = {}) => ({
    "_claude/rateLimit": {
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.25, resetsAt: 1792177800 },
        seven_day: { utilization: 0.5, resetsAt: 1792245600 },
      },
      ...overrides,
    },
  });

  it("reads every window", () => {
    const samples = parseClaudeRateLimit(rateLimit());
    expect(samples.map((s) => s.window)).toEqual(["five_hour", "seven_day"]);
    expect(samples.map((s) => s.utilization)).toEqual([0.25, 0.5]);
    expect(samples.every((s) => s.provider === "anthropic")).toBe(true);
  });

  it("puts the top-level status only on the window named by rateLimitType", () => {
    const samples = parseClaudeRateLimit(rateLimit({ rateLimitType: "seven_day", status: "rejected" }));
    expect(samples.find((s) => s.window === "seven_day")?.status).toBe("rejected");
    expect(samples.find((s) => s.window === "five_hour")?.status).toBeNull();
  });

  it("reads overage in use from either flag", () => {
    const viaOverageInUse = parseClaudeRateLimit(rateLimit({ overageInUse: true }));
    const viaIsUsingOverage = parseClaudeRateLimit(rateLimit({ isUsingOverage: true }));
    expect(viaOverageInUse.every((s) => s.overageInUse)).toBe(true);
    expect(viaIsUsingOverage.every((s) => s.overageInUse)).toBe(true);
  });

  it("skips a window whose utilisation cannot be read", () => {
    const samples = parseClaudeRateLimit(
      rateLimit({
        unifiedWindows: {
          five_hour: { utilization: "nope" },
          seven_day: { utilization: 0.5 },
        },
      }),
    );
    expect(samples.map((s) => s.window)).toEqual(["seven_day"]);
  });

  it("gives an empty list for a non-object", () => {
    expect(parseClaudeRateLimit(42)).toEqual([]);
    expect(parseClaudeRateLimit("nope")).toEqual([]);
  });
});

describe("parseCodexRateLimits", () => {
  const primary = { usedPercent: 40, windowDurationMins: 300, resetsAt: 1792177800 };
  const secondary = { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1792245600 };

  it("reads the same windows with and without the rateLimits wrapper", () => {
    const wrapped = parseCodexRateLimits({ rateLimits: { primary, secondary } });
    const bare = parseCodexRateLimits({ primary, secondary });
    expect(bare).toEqual(wrapped);
  });

  it("names the known and custom window lengths", () => {
    expect(parseCodexRateLimits({ primary })[0]!.window).toBe("five_hour");
    expect(parseCodexRateLimits({ primary: secondary })[0]!.window).toBe("seven_day");
    expect(parseCodexRateLimits({ primary: { usedPercent: 10, windowDurationMins: 60 } })[0]!.window).toBe("60_min");
  });

  it("falls back to the primary and secondary names when no duration is sent", () => {
    const samples = parseCodexRateLimits({
      primary: { usedPercent: 10 },
      secondary: { usedPercent: 20 },
    });
    expect(samples.map((s) => s.window)).toEqual(["primary", "secondary"]);
  });

  it("reads usedPercent as a fraction", () => {
    expect(parseCodexRateLimits({ primary })[0]!.utilization).toBe(0.4);
  });

  it("skips an entry with no usedPercent", () => {
    const samples = parseCodexRateLimits({ primary: { windowDurationMins: 300 }, secondary });
    expect(samples.map((s) => s.window)).toEqual(["seven_day"]);
  });
});

describe("windowLabel", () => {
  it("names the known windows", () => {
    expect(windowLabel("five_hour").name).toBe("5-hour window");
    expect(windowLabel("seven_day").name).toBe("This week");
    expect(windowLabel("synthetic_weekly").name).toBe("Weekly credit allowance");
    expect(windowLabel("synthetic_requests").name).toBe("Synthetic request window");
  });

  it("names a Fable key with its note", () => {
    for (const key of ["seven_day_fable", "overage_included", "fable_overage_included"]) {
      const label = windowLabel(key);
      expect(label.name).toBe("Fable (this week)");
      expect(label.note).toContain("50%");
    }
  });

  it("names a minute window", () => {
    expect(windowLabel("30_min").name).toBe("30-minute window");
  });

  it("turns an unknown key into a readable name", () => {
    expect(windowLabel("some_new_thing").name).toBe("Some new thing limit");
  });

  it("falls back to Other limit for an empty key", () => {
    expect(windowLabel("_").name).toBe("Other limit");
  });
});

describe("currentReportSamples (BOS-1916)", () => {
  const at = (iso: string, window: string) => ({ window, observedAt: new Date(iso) });

  it("keeps nothing when there are no samples", () => {
    expect(currentReportSamples([])).toEqual([]);
  });

  it("keeps a single sample, which is always the newest report", () => {
    const one = at("2026-11-21T08:00:00.000Z", "five_hour");
    expect(currentReportSamples([one])).toEqual([one]);
  });

  it("keeps every sample when they all came from the same report", () => {
    const samples = [at("2026-11-21T08:00:00.000Z", "five_hour"), at("2026-11-21T08:00:00.000Z", "seven_day")];
    expect(currentReportSamples(samples)).toEqual(samples);
  });

  it("drops windows left out of the newest report, keeping the current ones in order", () => {
    const current = [at("2026-11-21T08:00:00.000Z", "five_hour"), at("2026-11-21T08:00:00.000Z", "seven_day")];
    const old = at("2026-11-21T07:00:00.000Z", "fable");
    expect(currentReportSamples([old, ...current])).toEqual(current);
  });

  it("keeps a whole newer batch even when an older one had more windows", () => {
    const older = [at("2026-11-21T07:00:00.000Z", "five_hour"), at("2026-11-21T07:00:00.000Z", "seven_day")];
    const newest = at("2026-11-21T08:00:00.000Z", "five_hour");
    expect(currentReportSamples([...older, newest])).toEqual([newest]);
  });
});
