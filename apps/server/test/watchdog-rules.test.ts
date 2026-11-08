import { describe, expect, it } from "vitest";
import { DEFAULT_WATCHDOG, readWatchdogSettings } from "@boss-man/shared";
import { backoffGapMs, evaluate, isCrash, RUN_ENDED_GRACE_MS, type SnapHold, type SnapRun, type SnapTicket } from "../src/services/watchdog-rules.js";

const NOW = new Date("2026-10-26T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const s = { ...DEFAULT_WATCHDOG, enabled: true };

const ticket = (over: Partial<SnapTicket> = {}): SnapTicket => ({
  id: "t1",
  state: "in_progress",
  assigneeAgentId: "dev",
  assignedToOwner: false,
  stateChangedAt: ago(10),
  blockedUntil: null,
  scheduled: false,
  awaitingPlan: false,
  withOwner: false,
  bounces: 0,
  ...over,
});
const run = (over: Partial<SnapRun> = {}): SnapRun => ({ id: "r1", ticketId: "t1", agentId: "dev", startedAt: ago(60), endedAt: ago(50), outcome: "end_turn", ...over });
const rules = (tickets: SnapTicket[], runs: SnapRun[] = [], holds: SnapHold[] = []) => evaluate({ tickets, runs, holds }, s, NOW).map((x) => `${x.ticketId}:${x.rule}`);

describe("watchdog rules (BOS-58)", () => {
  it("flags unassigned ready or in-progress work after the short grace, even while a run works on it (BOS-26)", () => {
    expect(rules([ticket({ assigneeAgentId: null, stateChangedAt: ago(14) })])).toEqual([]);
    expect(rules([ticket({ assigneeAgentId: null, stateChangedAt: ago(15) })])).toEqual(["t1:unassigned"]);
    expect(rules([ticket({ state: "ready", assigneeAgentId: null, stateChangedAt: ago(60) })], [run({ agentId: "designer", endedAt: null })])).toEqual(["t1:unassigned"]);
    // The owner's own work and the backlog are not the watchdog's business.
    expect(rules([ticket({ assigneeAgentId: null, assignedToOwner: true, stateChangedAt: ago(60) })])).toEqual([]);
    expect(rules([ticket({ state: "backlog", assigneeAgentId: null, stateChangedAt: ago(600) })])).toEqual([]);
  });

  it("flags in progress and review after 2 h and blocked after 8 h, at the limit and not before", () => {
    // In progress with no run since it moved is the idle-capacity rule's (BOS-659): handed over at the short
    // limit, not after 2 h. A ticket that had a run and then stalled is the long rule's, at 2 h.
    expect(rules([ticket({ stateChangedAt: ago(14) })])).toEqual([]);
    expect(rules([ticket({ stateChangedAt: ago(15) })])).toEqual(["t1:idle_agent"]);
    const stalled = run({ startedAt: ago(180), endedAt: ago(170) });
    expect(rules([ticket({ stateChangedAt: ago(119) })], [stalled])).toEqual([]);
    expect(rules([ticket({ stateChangedAt: ago(120) })], [stalled])).toEqual(["t1:stale_in_progress"]);
    expect(rules([ticket({ state: "review", stateChangedAt: ago(119) })])).toEqual([]);
    expect(rules([ticket({ state: "review", stateChangedAt: ago(120) })])).toEqual(["t1:stale_review"]);
    // Approved by everyone and waiting for the merge sweep: not chased as stale review (BOS-362).
    expect(rules([ticket({ state: "review", stateChangedAt: ago(240), mergeWaiting: true })])).toEqual([]);
    expect(rules([ticket({ state: "blocked", stateChangedAt: ago(479) })])).toEqual([]);
    expect(rules([ticket({ state: "blocked", stateChangedAt: ago(480) })])).toEqual(["t1:stale_blocked"]);
    // Limits come from settings. A run that moved it to in-progress, then stalled: the long rule reads its setting.
    expect(evaluate({ tickets: [ticket({ stateChangedAt: ago(61) })], runs: [run({ startedAt: ago(120), endedAt: ago(70) })], holds: [] }, { ...s, inProgressHours: 1 }, NOW).map((x) => x.rule)).toEqual(["stale_in_progress"]);
    // The short idle limit is a setting too.
    expect(evaluate({ tickets: [ticket({ stateChangedAt: ago(10) })], runs: [], holds: [] }, { ...s, idleAgentMinutes: 5 }, NOW).map((x) => x.rule)).toEqual(["idle_agent"]);
  });

  it("stops the clock while a run works on the ticket, and pauses rather than resets it", () => {
    // Running now: never flagged, however long.
    expect(rules([ticket({ stateChangedAt: ago(600) })], [run({ startedAt: ago(5), endedAt: null })])).toEqual([]);
    // 3 h in review, of which a run worked for 90 min: 90 min of clock, not flagged.
    const worked = run({ startedAt: ago(170), endedAt: ago(80), outcome: "end_turn" });
    expect(rules([ticket({ state: "review", stateChangedAt: ago(180) })], [worked])).toEqual([]);
    // The same 90 min of running, but 4 h in review: 2.5 h of clock.
    expect(rules([ticket({ state: "review", stateChangedAt: ago(240) })], [worked])).toEqual(["t1:stale_review"]);
    // In progress: the run that moved it there counts only from the move; 80 of 180 min ran.
    const moved = run({ startedAt: ago(190), endedAt: ago(100) });
    expect(rules([ticket({ stateChangedAt: ago(180) })], [moved])).toEqual([]);
    expect(rules([ticket({ stateChangedAt: ago(230) })], [{ ...moved, startedAt: ago(240), endedAt: ago(150) }])).toEqual(["t1:stale_in_progress"]);
    // Someone else's run doesn't stop an in-progress clock. The assignee itself never ran, so the idle rule owns it.
    expect(rules([ticket({ stateChangedAt: ago(130) })], [run({ agentId: "other", startedAt: ago(125), endedAt: ago(5) })])).toEqual(["t1:idle_agent"]);
    // A scheduled check is a plan: no "no movement" while one is set.
    expect(rules([ticket({ stateChangedAt: ago(500), scheduled: true })])).toEqual([]);
  });

  it("rule 1 (BOS-659): hands an in-progress ticket the agent never ran to the Scrum Master at the short limit, once", () => {
    // A run that started on it clears the idle flag: the agent is not idle any more.
    expect(rules([ticket({ stateChangedAt: ago(600) })], [run({ startedAt: ago(5), endedAt: null })])).toEqual([]);
    // A run that ended before it moved to in progress is dropped from the snapshot (watchdog.ts), so it is
    // not one on this stretch of work: the ticket is still idle.
    expect(rules([ticket({ stateChangedAt: ago(600) })])).toEqual(["t1:idle_agent"]);
    // Waiting on a scheduled check or a plan approval is a plan, not an idle slot.
    expect(rules([ticket({ stateChangedAt: ago(600), scheduled: true })])).toEqual([]);
    expect(rules([ticket({ stateChangedAt: ago(600), awaitingPlan: true })])).toEqual([]);
  });

  it("rule 1 (BOS-659 live follow-up): an agent that picked the ticket up and whose run then ended is idle at the short limit too", () => {
    // The real shape: the scheduler moves the ticket in progress, the run starts just after and ends normally.
    // It used to fall through to the 45-minute grace and the long rule, so half the slots sat empty for hours.
    const picked = run({ startedAt: ago(29), endedAt: ago(20), outcome: "end_turn" });
    expect(rules([ticket({ stateChangedAt: ago(30) })], [picked])).toEqual(["t1:idle_agent"]);
    // Not before the short limit.
    expect(rules([ticket({ stateChangedAt: ago(30) })], [{ ...picked, endedAt: ago(5) }])).toEqual([]);
    // A crash is not this rule's: Boss Man's free recovery goes first, then its own rule.
    expect(rules([ticket({ stateChangedAt: ago(30) })], [{ ...picked, outcome: "error: out of memory" }])).toEqual([]);
    // Past the grace the long rule owns it, so the two don't both wake the assignee for one idle spell.
    expect(rules([ticket({ stateChangedAt: ago(60) })], [{ ...picked, startedAt: ago(59), endedAt: ago(50) }])).toEqual(["t1:run_ended_unmoved"]);
  });

  it("rule 2 (BOS-659): flags a ready, assigned ticket whose blockers are all finished and which nothing has run on", () => {
    const ready = (over: Partial<SnapTicket> = {}) => ticket({ state: "ready", stateChangedAt: ago(30), ...over });
    const done: SnapHold = { blockedTicketId: "t1", kind: "ticket", holderTicketId: "x", resolved: true };
    // Released to ready 20 min ago, assigned, never run: handed off.
    expect(rules([ready({ unblockedAt: ago(20), stateChangedAt: ago(60) })], [], [done])).toEqual(["t1:unstarted"]);
    // Inside the short grace: the scheduler may still be about to start it.
    expect(rules([ready({ unblockedAt: ago(5), stateChangedAt: ago(60) })], [], [done])).toEqual([]);
    // A run has started on it since: not "unstarted".
    expect(rules([ready({ unblockedAt: ago(20), stateChangedAt: ago(60) })], [run({ startedAt: ago(10), endedAt: null })], [done])).toEqual([]);
    // Nothing has freed it: ready work with no blocker is missed work's business, not this rule's.
    expect(rules([ready({ stateChangedAt: ago(60) })])).toEqual([]);
    // Still held by a blocker: not unstarted.
    expect(rules([ready({ unblockedAt: ago(20), stateChangedAt: ago(60) })], [], [{ ...done, resolved: false }])).toEqual([]);
    // Unassigned ready work is the unassigned rule's.
    expect(rules([ready({ unblockedAt: ago(20), stateChangedAt: ago(60), assigneeAgentId: null })], [], [done])).toEqual(["t1:unassigned"]);
  });

  it("flags a crashed run, and a run that ended without moving the ticket, after the grace and only if nothing is scheduled", () => {
    const crashed = run({ startedAt: ago(5 + RUN_ENDED_GRACE_MS / 60_000), endedAt: ago(RUN_ENDED_GRACE_MS / 60_000), outcome: "error: Out of memory" });
    expect(rules([ticket({ stateChangedAt: ago(200) })], [crashed])).toEqual(["t1:run_crashed"]);
    expect(rules([ticket({ stateChangedAt: ago(200) })], [{ ...crashed, endedAt: ago(RUN_ENDED_GRACE_MS / 60_000 - 1) }])).toEqual([]);
    expect(rules([ticket({ stateChangedAt: ago(200), scheduled: true })], [crashed])).toEqual([]);
    const ended = { ...crashed, outcome: "end_turn" };
    expect(rules([ticket({ stateChangedAt: ago(200) })], [ended])).toEqual(["t1:run_ended_unmoved"]);
    // The run moved it (the state changed after the run started): not "ended without moving".
    expect(rules([ticket({ stateChangedAt: ago(RUN_ENDED_GRACE_MS / 60_000 + 1) })], [ended])).toEqual([]);
    expect(isCrash("lost: runner offline")).toBe(true);
    expect(isCrash("interrupted")).toBe(true);
    expect(isCrash("end_turn")).toBe(false);
    expect(isCrash(null)).toBe(false);
  });

  it("flags review loops past the bounce limit, whatever the state", () => {
    expect(rules([ticket({ bounces: 2 })])).toEqual([]);
    expect(rules([ticket({ bounces: 3 })])).toEqual(["t1:review_loop"]);
    expect(evaluate({ tickets: [ticket({ bounces: 4 })], runs: [], holds: [] }, s, NOW)[0]!.detail.bounces).toBe(4);
  });

  it("rule 1: a ticket held by another ticket is not flagged; the holder is, with how many it holds", () => {
    const blocked = ticket({ id: "b", state: "blocked", stateChangedAt: ago(2000) });
    const holder = ticket({ id: "h", stateChangedAt: ago(130) });
    const hold: SnapHold = { blockedTicketId: "b", kind: "ticket", holderTicketId: "h", resolved: false };
    const trips = evaluate({ tickets: [blocked, holder], runs: [], holds: [hold] }, s, NOW);
    expect(trips.map((x) => `${x.ticketId}:${x.rule}`)).toEqual(["h:idle_agent"]);
    expect(trips[0]!.detail.holds).toBe(1);
    // Once the holder is done, the blocked ticket is judged on the normal 8 h.
    expect(rules([blocked], [], [{ ...hold, resolved: true }])).toEqual(["b:stale_blocked"]);
    // An engagement holds the same way.
    expect(rules([blocked], [], [{ blockedTicketId: "b", kind: "engagement", resolved: false }])).toEqual([]);
  });

  it("rule 2: a ticket waiting on the owner's decision chases nobody, and is flagged for the owner after 8 h", () => {
    const t = ticket({ state: "blocked", stateChangedAt: ago(2000), bounces: 0 });
    const d = (min: number): SnapHold => ({ blockedTicketId: "t1", kind: "decision", decisionId: "d1", resolved: false, openedAt: ago(min) });
    expect(rules([t], [], [d(479)])).toEqual([]);
    expect(rules([t], [], [d(480)])).toEqual(["t1:owner_decision_waiting"]);
    // Also for a ticket in review waiting on the owner's sign-off.
    expect(rules([ticket({ state: "review", stateChangedAt: ago(2000) })], [], [d(500)])).toEqual(["t1:owner_decision_waiting"]);
  });

  it("rule 3: quiet until 'blocked until' plus 2 h, then flagged; no date means the normal limit", () => {
    const until = (min: number) => ticket({ state: "blocked", stateChangedAt: ago(5000), blockedUntil: ago(min) });
    expect(rules([ticket({ state: "blocked", stateChangedAt: ago(5000), blockedUntil: new Date(NOW.getTime() + 3_600_000) })])).toEqual([]);
    expect(rules([until(119)])).toEqual([]);
    expect(rules([until(120)])).toEqual(["t1:blocked_until_passed"]);
  });

  it("leaves alone what is already with the owner, or waiting on a plan approval", () => {
    expect(rules([ticket({ stateChangedAt: ago(500), withOwner: true })])).toEqual([]);
    expect(rules([ticket({ stateChangedAt: ago(500), awaitingPlan: true })])).toEqual([]);
  });

  it("reads stored settings defensively", () => {
    expect(readWatchdogSettings(null)).toEqual(DEFAULT_WATCHDOG);
    expect(readWatchdogSettings({ enabled: true, inProgressHours: -3, reviewHours: 4, junk: 1 })).toEqual({ ...DEFAULT_WATCHDOG, enabled: true, reviewHours: 4 });
  });

  it("backs a repeat flag off: the rule's limit, then twice, then four times, up to 24 hours (BOS-121)", () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((n) => backoffGapMs("stale_in_progress", { ...s, inProgressHours: 2 }, n) / 3_600_000);
    expect(hours).toEqual([2, 4, 8, 16, 24, 24, 24]);
    // A limit already longer than a day is never shortened by the cap.
    expect(backoffGapMs("stale_in_progress", { ...s, inProgressHours: 30 }, 3) / 3_600_000).toBe(30);
  });
});
