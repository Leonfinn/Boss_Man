import { describe, expect, it } from "vitest";
import { attemptsOf, median, perDay, type Ev } from "../src/services/merge-history.js";

const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 10, min));
const ev = (ticketId: string, min: number, detail: Record<string, unknown>): Ev => ({ ticketId, at: at(min), detail });

describe("merge history", () => {
  it("reads a landed merge: slot wait, check length, machine, GitHub CI wait, total", () => {
    const [a, ...rest] = attemptsOf([
      ev("t1", 0, { event: "attempt" }),
      ev("t1", 1, { event: "check_queued" }),
      ev("t1", 6, { event: "check_started", ranOn: "worker-a" }),
      ev("t1", 16, { event: "check_ended", passed: true }),
      ev("t1", 17, { event: "ci_wait_ended", outcome: "passed", waitedMs: 120_000 }),
      ev("t1", 20, { event: "merged" }),
    ]);
    expect(rest).toEqual([]);
    expect(a!.result).toBe("landed");
    expect(a!.checkQueuedAt!.getTime() - a!.queuedAt.getTime()).toBe(60_000);
    expect(a!.startedAt!.getTime() - a!.checkQueuedAt!.getTime()).toBe(5 * 60_000);
    expect(a!.checkEndedAt!.getTime() - a!.startedAt!.getTime()).toBe(10 * 60_000);
    expect(a!.ranOn).toBe("worker-a");
    expect(a!.ciWaitMs).toBe(120_000);
  });

  it("a bounce ends one attempt and the retry is a new one; cancelled and still-open ones are told apart", () => {
    const rows = attemptsOf([
      ev("t1", 0, { event: "check_queued" }),
      ev("t1", 5, { event: "attempt_failed", reason: "check_failed", jobId: "j1", note: "boom" }),
      ev("t1", 10, { event: "attempt" }),
      ev("t1", 11, { event: "check_queued" }),
      ev("t1", 20, { event: "merged" }),
      ev("t2", 0, { event: "attempt" }),
      ev("t2", 3, { event: "left", to: "in_progress" }),
      ev("t3", 0, { event: "attempt" }),
      ev("t4", 0, { event: "merged" }),
    ]);
    expect(rows.map((r) => `${r.ticketId}:${r.result}`)).toEqual(["t1:bounced", "t1:landed", "t2:cancelled"]);
    expect(rows[0]).toMatchObject({ reason: "check_failed", jobId: "j1", note: "boom" });
  });

  it("median and per-day lines: landed and bounced counts, median queued-to-landed, newest day first", () => {
    expect(median([])).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
    const days = perDay([
      { result: "landed", endedAt: "2026-11-21T09:00:00.000Z", totalMs: 600_000 },
      { result: "landed", endedAt: "2026-11-21T11:00:00.000Z", totalMs: 1_200_000 },
      { result: "bounced", endedAt: "2026-11-21T12:00:00.000Z", totalMs: null },
      { result: "cancelled", endedAt: "2026-11-21T12:30:00.000Z", totalMs: null },
      { result: "bounced", endedAt: "2026-11-22T12:00:00.000Z", totalMs: null },
    ]);
    expect(days).toEqual([
      { day: "2026-11-22", landed: 0, bounced: 1, medianMs: null },
      { day: "2026-11-21", landed: 2, bounced: 1, medianMs: 900_000 },
    ]);
  });
});
