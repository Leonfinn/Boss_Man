import { describe, expect, it } from "vitest";
import {
  BLOCKED_UNTIL_MAX_DAYS,
  BLOCKED_UNTIL_MAX_MS,
  DEFAULT_WATCHDOG,
  parkedOnPurpose,
  readWatchdogSettings,
  WATCHDOG_NON_CAPPED_KINDS,
  WATCHDOG_NUDGE_KINDS,
  WATCHDOG_RECORD_KINDS,
  WatchdogSettings,
} from "../src/watchdog.js";

describe("DEFAULT_WATCHDOG", () => {
  it("is itself valid watchdog settings", () => {
    expect(WatchdogSettings.parse(DEFAULT_WATCHDOG)).toEqual(DEFAULT_WATCHDOG);
  });
});

describe("readWatchdogSettings", () => {
  it("gives the defaults for a missing or non-object value", () => {
    expect(readWatchdogSettings(null)).toEqual(DEFAULT_WATCHDOG);
    expect(readWatchdogSettings(undefined)).toEqual(DEFAULT_WATCHDOG);
    expect(readWatchdogSettings("enabled: true")).toEqual(DEFAULT_WATCHDOG);
    expect(readWatchdogSettings([])).toEqual(DEFAULT_WATCHDOG);
  });

  it("keeps a valid field", () => {
    expect(readWatchdogSettings({ reviewHours: 4 })).toEqual({ ...DEFAULT_WATCHDOG, reviewHours: 4 });
  });

  it("falls back one bad field at a time and keeps the valid fields beside it", () => {
    const out = readWatchdogSettings({
      unassignedMinutes: 0,
      maxNudgesPerHour: 101,
      inProgressHours: "2",
      reviewHours: 4,
    });
    expect(out.unassignedMinutes).toBe(DEFAULT_WATCHDOG.unassignedMinutes);
    expect(out.maxNudgesPerHour).toBe(DEFAULT_WATCHDOG.maxNudgesPerHour);
    expect(out.inProgressHours).toBe(DEFAULT_WATCHDOG.inProgressHours);
    expect(out.reviewHours).toBe(4);
  });

  it("drops an unknown key", () => {
    const out = readWatchdogSettings({ enabled: false, junk: 1 });
    expect(out).toEqual({ ...DEFAULT_WATCHDOG, enabled: false });
    expect(out).not.toHaveProperty("junk");
  });
});

describe("parkedOnPurpose", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const ahead = new Date(now.getTime() + 3_600_000);
  const behind = new Date(now.getTime() - 3_600_000);

  it("is true while a 'blocked until' time is still ahead", () => {
    expect(parkedOnPurpose({ blockedUntil: ahead }, now)).toBe(true);
  });

  it("is false once the 'blocked until' time is past", () => {
    expect(parkedOnPurpose({ blockedUntil: behind }, now)).toBe(false);
  });

  it("is still true after the time when the note says parked", () => {
    expect(parkedOnPurpose({ blockedUntil: behind, stateNote: "Parked until Friday" }, now)).toBe(true);
  });

  it("reads the word parked in any case", () => {
    expect(parkedOnPurpose({ stateNote: "Parked until Friday" }, now)).toBe(true);
    expect(parkedOnPurpose({ stateNote: "PARKED for now" }, now)).toBe(true);
    expect(parkedOnPurpose({ stateNote: "we parked this until the release" }, now)).toBe(true);
  });

  it("does not treat 'unparked' as parked", () => {
    expect(parkedOnPurpose({ stateNote: "unparked, ready to start" }, now)).toBe(false);
  });

  it("is false with no note and no time", () => {
    expect(parkedOnPurpose({}, now)).toBe(false);
    expect(parkedOnPurpose({ stateNote: null, blockedUntil: null }, now)).toBe(false);
  });
});

describe("watchdog kind lists", () => {
  it("counts every record-only kind as non-capped", () => {
    for (const kind of WATCHDOG_RECORD_KINDS) expect(WATCHDOG_NON_CAPPED_KINDS).toContain(kind);
  });

  it("never counts a nudge kind as non-capped", () => {
    const both = WATCHDOG_NON_CAPPED_KINDS.filter((kind) => WATCHDOG_NUDGE_KINDS.includes(kind));
    expect(both).toEqual([]);
  });

  it("caps 'blocked until' at 30 days", () => {
    expect(BLOCKED_UNTIL_MAX_DAYS).toBe(30);
    expect(BLOCKED_UNTIL_MAX_MS).toBe(30 * 24 * 3_600_000);
  });
});
