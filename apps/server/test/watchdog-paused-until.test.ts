import { describe, expect, it } from "vitest";
import { watchdogPausedUntil } from "../src/services/watchdog.js";

const H = 3_600_000;
const M = 60_000;
const S = 1_000;
const at = new Date("2026-11-13T12:00:00.000Z");
const ago = (ms: number) => new Date(at.getTime() - ms);
const pausedUntil = (watchdog: unknown, trippedAt: Date | null) => watchdogPausedUntil({ watchdog, watchdogTrippedAt: trippedAt }, at);

describe("watchdogPausedUntil (BOS-1346)", () => {
  it("is not paused when the watchdog never tripped", () => {
    expect(pausedUntil({ enabled: true }, null)).toBeNull();
  });

  it("pauses until one hour after a fresh trip", () => {
    const tripped = ago(10 * M);
    expect(pausedUntil({ enabled: true }, tripped)?.getTime()).toBe(tripped.getTime() + H);
  });

  it("is still paused at 59 minutes 59 seconds after the trip", () => {
    const tripped = ago(59 * M + 59 * S);
    expect(pausedUntil({ enabled: true }, tripped)?.getTime()).toBe(at.getTime() + S);
  });

  it("is no longer paused when the hour has passed exactly", () => {
    expect(pausedUntil({ enabled: true }, ago(H))).toBeNull();
  });

  it("is no longer paused two hours after the trip", () => {
    expect(pausedUntil({ enabled: true }, ago(2 * H))).toBeNull();
  });

  it("is not paused when the watchdog is switched off, even just after a trip", () => {
    expect(pausedUntil({ enabled: false }, ago(10 * M))).toBeNull();
  });

  it("reads missing or non-object settings as switched on, so a fresh trip pauses", () => {
    const tripped = ago(10 * M);
    const until = tripped.getTime() + H;
    expect(pausedUntil(null, tripped)?.getTime()).toBe(until);
    expect(pausedUntil({}, tripped)?.getTime()).toBe(until);
    expect(pausedUntil("not a settings object", tripped)?.getTime()).toBe(until);
  });

  it("falls back to switched on when enabled holds a bad value", () => {
    expect(pausedUntil({ enabled: "no" }, ago(10 * M))?.getTime()).toBe(ago(10 * M).getTime() + H);
  });
});
