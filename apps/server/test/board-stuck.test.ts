// BOS-1910: the board's "looks stuck" verdict comes from the watchdog's handed-on flag, and never for the parked kinds.
import { describe, expect, it } from "vitest";
import { looksStuck, type StuckFlag } from "../src/services/board-stuck.js";

const now = new Date("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const flag = (over: Partial<StuckFlag> = {}): StuckFlag => ({ rule: "stale_in_progress", openedAt: new Date(now.getTime() - DAY), lastFlaggedAt: new Date(now.getTime() - 3_600_000), detail: { idleMs: 3 * DAY }, ...over });
const plain = { beingChecked: false, nextUp: false, watching: false };

describe("looksStuck", () => {
  it("reports the idle time the watchdog recorded", () => {
    expect(looksStuck(flag(), plain, now)?.idleMs).toBe(3 * DAY);
  });
  it("falls back to the flag's age", () => {
    expect(looksStuck(flag({ detail: {} }), plain, now)?.idleMs).toBe(DAY);
  });
  it("is null with no flag, before the Scrum Master is told, and for the owner's own reminder", () => {
    expect(looksStuck(undefined, plain, now)).toBeNull();
    expect(looksStuck(flag({ lastFlaggedAt: null }), plain, now)).toBeNull();
    expect(looksStuck(flag({ rule: "owner_decision_waiting" }), plain, now)).toBeNull();
  });
  it("never flags Being checked, Merged watching (before its date) or Next up", () => {
    expect(looksStuck(flag(), { ...plain, beingChecked: true }, now)).toBeNull();
    expect(looksStuck(flag(), { ...plain, watching: true }, now)).toBeNull();
    expect(looksStuck(flag(), { ...plain, nextUp: true }, now)).toBeNull();
  });
});
