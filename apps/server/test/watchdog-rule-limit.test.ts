import { describe, expect, it } from "vitest";
import { DEFAULT_WATCHDOG, type WatchdogRule } from "@boss-man/shared";
import { BACKOFF_CAP_MS, ruleLimitMs } from "../src/services/watchdog-rules.js";

const H = 3_600_000;
const M = 60_000;

const s = {
  ...DEFAULT_WATCHDOG,
  unassignedMinutes: 7,
  reviewHours: 3,
  blockedHours: 5,
  blockedUntilGraceHours: 2,
  inProgressHours: 11,
  ownerDecisionHours: 13,
};

describe("watchdog rule limits (BOS-1293)", () => {
  it("uses each rule's own setting", () => {
    expect(ruleLimitMs("unassigned", s)).toBe(7 * M);
    expect(ruleLimitMs("stale_review", s)).toBe(3 * H);
    expect(ruleLimitMs("review_loop", s)).toBe(3 * H);
    expect(ruleLimitMs("stale_blocked", s)).toBe(5 * H);
    expect(ruleLimitMs("blocked_until_passed", s)).toBe(2 * H);
    expect(ruleLimitMs("owner_decision_waiting", s)).toBe(24 * H);
  });

  it("keeps owner decisions at a day whatever the setting says", () => {
    expect(ruleLimitMs("owner_decision_waiting", { ...s, ownerDecisionHours: 1 })).toBe(24 * H);
    expect(ruleLimitMs("owner_decision_waiting", { ...s, ownerDecisionHours: 8 })).toBe(24 * H);
    expect(ruleLimitMs("owner_decision_waiting", { ...s, ownerDecisionHours: 336 })).toBe(24 * H);
  });

  it("never quiets a passed blocked-until flag for less than an hour", () => {
    expect(ruleLimitMs("blocked_until_passed", { ...s, blockedUntilGraceHours: 0 })).toBe(H);
    expect(ruleLimitMs("blocked_until_passed", { ...s, blockedUntilGraceHours: 0.5 })).toBe(H);
    expect(ruleLimitMs("blocked_until_passed", { ...s, blockedUntilGraceHours: 1 })).toBe(H);
    expect(ruleLimitMs("blocked_until_passed", { ...s, blockedUntilGraceHours: 1.5 })).toBe(1.5 * H);
  });

  it("gives idle and unstarted conditions one hand-off a day (BOS-659)", () => {
    expect(BACKOFF_CAP_MS).toBe(24 * H);
    expect(ruleLimitMs("idle_agent", s)).toBe(BACKOFF_CAP_MS);
    expect(ruleLimitMs("unstarted", s)).toBe(BACKOFF_CAP_MS);
    expect(ruleLimitMs("idle_agent", { ...s, inProgressHours: 0.25 })).toBe(BACKOFF_CAP_MS);
    expect(ruleLimitMs("unstarted", { ...s, idleAgentMinutes: 5 })).toBe(BACKOFF_CAP_MS);
  });

  it("falls back to the in-progress setting for rules with no limit of their own", () => {
    const others: WatchdogRule[] = ["run_crashed", "run_ended_unmoved", "stale_in_progress"];
    for (const rule of others) expect(ruleLimitMs(rule, s)).toBe(11 * H);
    expect(ruleLimitMs("stale_in_progress", { ...s, inProgressHours: 0.5 })).toBe(0.5 * H);
  });
});
