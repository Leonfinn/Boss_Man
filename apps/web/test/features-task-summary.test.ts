// BOS-1946 (Background lane): the pure helper behind the Features table's WORK column had no direct
// test. taskSummary reads a feature's tasks in plain words: done of all, and any blocked.
import { describe, expect, it } from "vitest";
import type { Feature } from "../src/api";
import { taskSummary } from "../src/pages/Features";

const task = (id: string, state: string, outcome: string | null = null) => ({ id, title: `Task ${id}`, state, outcome, assignee: null });

const feature = (items: Array<ReturnType<typeof task>>): Feature =>
  ({
    id: "f1",
    companyId: "c1",
    areaId: null,
    parentId: null,
    title: "Gift cards",
    description: null,
    status: "planned",
    effort: 3,
    rank: null,
    horizon: null,
    driverScores: {},
    milestoneId: null,
    objectiveId: null,
    portalVisible: false,
    keepOffPortal: false,
    keepOffReason: null,
    publicSummary: null,
    publicTitle: null,
    showPublicly: false,
    createdAt: "2026-10-19T09:00:00Z",
    updatedAt: "2026-10-19T09:00:00Z",
    releasedAt: null,
    demand: 0,
    insightCount: 0,
    customerCount: 0,
    value: 0,
    demandPart: 0,
    priority: 0,
    tickets: { total: items.length, done: items.filter((t) => t.state === "done").length, items },
  }) as Feature;

describe("taskSummary", () => {
  it("shows a dash when the feature has no tasks", () => {
    expect(taskSummary(feature([]))).toBe("–");
  });

  it("says one of one complete for a single finished task", () => {
    expect(taskSummary(feature([task("a", "done")]))).toBe("1 of 1 complete");
  });

  it("says every task is done when all are", () => {
    expect(taskSummary(feature([task("a", "done"), task("b", "done"), task("c", "done")]))).toBe("3 of 3 complete");
  });

  it("counts done of all across a mix of states", () => {
    expect(taskSummary(feature([task("a", "done"), task("b", "in_progress"), task("c", "ready")]))).toBe("1 of 3 complete");
    expect(taskSummary(feature([task("a", "done"), task("b", "done"), task("c", "in_progress")]))).toBe("2 of 3 complete");
  });

  it("adds the blocked count after the total", () => {
    expect(taskSummary(feature([task("a", "done"), task("b", "blocked"), task("c", "in_progress")]))).toBe("1 of 3 complete · 1 blocked");
    expect(taskSummary(feature([task("a", "blocked"), task("b", "blocked")]))).toBe("0 of 2 complete · 2 blocked");
  });

  it("counts a cancelled task for neither done nor all", () => {
    expect(taskSummary(feature([task("a", "done"), task("b", "in_progress", "cancelled")]))).toBe("1 of 1 complete");
    expect(taskSummary(feature([task("a", "in_progress", "cancelled")]))).toBe("–");
  });
});
