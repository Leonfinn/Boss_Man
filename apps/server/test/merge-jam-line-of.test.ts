// lineOf (BOS-766, BOS-1594, BOS-1849) is the one bridge from the Merge queue read to the jam alert's
// verdict. It maps two kinds of input:
//   - a view that already carries `line`: that verdict is returned untouched, whatever the rest of the
//     view says, so the banner and the alert can never disagree;
//   - a view from an older caller with no `line`: classified here by the shared mergeLineHealth, at the
//     clock handed in (`at`), so the same line reads slow now and stuck once nothing has landed.
// These tests pin those two paths, the states each can produce, and that `at` is the clock used.
import { describe, expect, it } from "vitest";
import { lineOf } from "../src/services/merge-jam.js";
import { mergeLineHealth, type MergeLineHealth } from "../src/services/merge-line-health.js";
import type { MergeQueueView, RecentRow, RunningNow, WaitingRow } from "../src/services/merge-queue.js";

const AT = new Date("2026-11-18T12:00:00Z");
const MIN = 60_000;
const isoBefore = (minutes: number, at: Date = AT) => new Date(at.getTime() - minutes * MIN).toISOString();

function view(over: Partial<MergeQueueView> = {}): MergeQueueView {
  return {
    companyId: "c1",
    mode: "server",
    slots: 3,
    running: [],
    waiting: [],
    recent: [],
    waitingCount: 0,
    lineCount: 0,
    stuckCount: 0,
    line: { state: "healthy" },
    ...over,
  };
}

// The shape before `line` existed (an older caller): no `line` at runtime, so lineOf classifies it.
function olderView(over: Partial<MergeQueueView> = {}): MergeQueueView {
  return view({ ...over, line: undefined as unknown as MergeLineHealth });
}

function waiting(over: Partial<WaitingRow> = {}): WaitingRow {
  return {
    ticketId: "t1",
    ref: "BOS-11",
    title: "Build the page",
    minutes: 65,
    state: "waiting_for_seat",
    label: "waiting for a merge seat",
    stuck: true,
    next: null,
    actor: "system",
    decisionId: null,
    risk: "medium",
    urgent: false,
    failedCheck: false,
    ...over,
  };
}

function running(over: Partial<RunningNow> = {}): RunningNow {
  return {
    ticketId: "t9",
    ref: "BOS-9",
    title: "The big merge",
    phase: "checking",
    startedAt: isoBefore(75),
    startedBy: "you",
    minutes: 75,
    what: "merge_check",
    slot: 1,
    overLimit: true,
    statusLine: { step: "checking", since: isoBefore(75), next: "it merges when the check passes", blocker: null },
    ...over,
  };
}

function mergedAgo(minutes: number): RecentRow {
  return { ticketId: "t0", ref: "BOS-1", title: "Landed", result: "merged", detail: "", at: isoBefore(minutes) };
}

describe("lineOf (BOS-1849)", () => {
  it("returns the verdict the Merge queue read carries, untouched, even when the view's data would say otherwise", () => {
    const carried: MergeLineHealth = { state: "healthy" };
    const withStuckData = view({ line: carried, running: [running()], waiting: [waiting()] });
    expect(lineOf(withStuckData, AT)).toBe(carried);

    const paused: MergeLineHealth = { state: "paused", reason: "a server update", since: isoBefore(5), until: isoBefore(-10), inUse: 1, slots: 3 };
    expect(lineOf(view({ line: paused, running: [running()] }), AT)).toBe(paused);
  });

  it("classifies a view from an older caller with the shared health function, at the clock it is given", () => {
    const line = olderView({ waiting: [waiting()], recent: [mergedAgo(10)] });
    expect(lineOf(line, AT)).toEqual(mergeLineHealth(line, { now: AT }));
    expect(lineOf(line, AT)).toMatchObject({ state: "over_capacity", waiting: 1, etaMinutes: null });
  });

  it("reads an older view with nothing waiting and nothing stuck as healthy", () => {
    expect(lineOf(olderView({ recent: [mergedAgo(5)] }), AT)).toEqual({ state: "healthy" });
  });

  it("reads a merge check past the hour as stuck on a check that is too long", () => {
    const line = lineOf(olderView({ running: [running()] }), AT);
    expect(line).toMatchObject({ state: "stuck", cause: "check_too_long", others: 0 });
    expect(line.state === "stuck" && line.title).toBe("BOS-9 has been in its check for 1 h 15 min");
  });

  it("reads a waiting row stuck on something that is not just capacity as a gate fault", () => {
    const line = lineOf(olderView({ waiting: [waiting({ state: "waiting_host", label: "waiting for the Docker host" })] }), AT);
    expect(line).toMatchObject({ state: "stuck", cause: "gate_fault" });
    expect(line.state === "stuck" && line.title).toBe("BOS-11 has waited 1 h 5 min to merge");
  });

  it("uses the clock it is given: slow now, and stuck once nothing has landed for long enough", () => {
    const line = olderView({ waiting: [waiting()], recent: [mergedAgo(10)] });
    expect(lineOf(line, AT)).toMatchObject({ state: "over_capacity" });
    const later = new Date(AT.getTime() + 40 * MIN);
    const stuck = lineOf(line, later);
    expect(stuck).toMatchObject({ state: "stuck", cause: "no_landing" });
    expect(stuck.state === "stuck" && stuck.title).toBe("Nothing has merged for 50 min");
  });

  it("never reads an older view as paused: a pause only comes with the view itself", () => {
    const line = olderView({ waiting: [waiting()], recent: [mergedAgo(10)] });
    expect(lineOf(line, AT).state).not.toBe("paused");
  });
});
