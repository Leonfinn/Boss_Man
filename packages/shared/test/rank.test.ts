import { describe, expect, it } from "vitest";
import { objectiveWeight, rankDecision, urgencyPoints } from "../src/rank.js";

const now = new Date("2026-10-16T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe("rankDecision", () => {
  it("scores a row that blocks nothing by age alone", () => {
    const r = rankDecision({ createdAt: hoursAgo(36), blocked: [] }, now);
    expect(r.parts).toEqual({ blocking: 0, urgency: 0, age: 1.5, liveRun: 0 });
    expect(r.score).toBe(1.5);
    expect(r.reasons).toEqual(["Waiting 36 h"]);
  });

  it("weights blocked work by objective priority and halves it down the chain", () => {
    const r = rankDecision(
      {
        createdAt: now,
        blocked: [
          { depth: 1, objectivePriority: 1, dueDate: null },
          { depth: 2, objectivePriority: null, dueDate: null },
        ],
      },
      now,
    );
    // 2 × (4 + 1 × 0.5)
    expect(r.parts.blocking).toBe(9);
    expect(r.reasons).toContain("Blocks 1 ticket directly and 1 more down the chain");
    expect(r.reasons).toContain("Holds up P1 objective work");
  });

  it("uses the nearest due date among blocked tickets", () => {
    const r = rankDecision(
      {
        createdAt: now,
        blocked: [
          { depth: 1, objectivePriority: null, dueDate: "2026-10-30" },
          { depth: 3, objectivePriority: null, dueDate: "2026-10-14" },
        ],
      },
      now,
    );
    expect(r.dueDate).toBe("2026-10-14");
    expect(r.parts.urgency).toBe(10);
    expect(r.reasons).toContain("Overdue by 2 days");
  });

  it("puts a paused agent ahead of an equally old question", () => {
    const paused = rankDecision({ createdAt: hoursAgo(1), blocked: [], holdsLiveRun: true }, now);
    const question = rankDecision({ createdAt: hoursAgo(1), blocked: [] }, now);
    expect(paused.score).toBeGreaterThan(question.score);
    expect(paused.reasons[0]).toBe("An agent is paused until you answer");
  });

  it("caps age at a week", () => {
    expect(rankDecision({ createdAt: hoursAgo(24 * 30), blocked: [] }, now).parts.age).toBe(7);
  });
});

describe("weights", () => {
  it("ranks P1 above unlinked work", () => {
    expect([1, 2, 3, 4, 5, null].map(objectiveWeight)).toEqual([4, 3, 2, 1.5, 1, 1]);
  });
  it("gives more urgency the closer the date", () => {
    expect([-1, 0, 1, 2, 5, 10, 30].map(urgencyPoints)).toEqual([10, 8, 6, 6, 3, 1, 0]);
  });
});
