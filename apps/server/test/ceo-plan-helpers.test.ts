// BOS-1430 (background lane): the pure helpers behind the CEO's plan on a ticket. The plan is shown with
// its deadline (and says when that deadline has passed), only an unexpired plan holds a ticket, the moves
// that leave a plan or send an urgent ticket backwards are recognised, and the mover and the CEO get the
// right words about it. No database and no clock of its own: every "now" is passed in.
import { describe, expect, it } from "vitest";
import { ceoMoveNote, ceoPlanText, leavesPlan, planMoveWarning, unexpiredPlan, urgentBackwards } from "../src/services/ceo-plan.js";

const NOW = new Date("2026-11-15T09:00:00.000Z");
const FUTURE = new Date("2026-11-16T12:00:00.000Z");
const PAST = new Date("2026-11-15T08:00:00.000Z");

const plan = (ceoPlan: string | null, ceoPlanDeadline: Date | null = null) => ({ ceoPlan, ceoPlanDeadline });

describe("ceoPlanText", () => {
  it("shows the plan with a deadline still ahead", () => {
    expect(ceoPlanText(plan("Split it in two", FUTURE), NOW)).toBe("CEO plan (due 2026-11-16 12:00 UTC): Split it in two");
  });

  it("marks a deadline that has gone as passed", () => {
    expect(ceoPlanText(plan("Split it in two", PAST), NOW)).toBe("CEO plan (due 2026-11-15 08:00 UTC, passed): Split it in two");
  });

  it("marks a deadline exactly at now as passed", () => {
    expect(ceoPlanText(plan("Split it in two", NOW), NOW)).toBe("CEO plan (due 2026-11-15 09:00 UTC, passed): Split it in two");
  });

  it("says so when there is no deadline", () => {
    expect(ceoPlanText(plan("Split it in two"), NOW)).toBe("CEO plan (no deadline): Split it in two");
  });

  it("has nothing to show for a missing, empty or whitespace-only plan", () => {
    expect(ceoPlanText(plan(null), NOW)).toBeNull();
    expect(ceoPlanText(plan(""), NOW)).toBeNull();
    expect(ceoPlanText(plan("  \n\t "), NOW)).toBeNull();
  });

  it("trims space around the plan", () => {
    expect(ceoPlanText(plan("  Split it in two  "), NOW)).toBe("CEO plan (no deadline): Split it in two");
  });

  it("leaves a plan of exactly the limit alone and shortens a longer one with an ellipsis", () => {
    expect(ceoPlanText(plan("x".repeat(10)), NOW, 10)).toBe(`CEO plan (no deadline): ${"x".repeat(10)}`);
    expect(ceoPlanText(plan("abcdefghijk"), NOW, 10)).toBe("CEO plan (no deadline): abcdefghi…");
  });

  it("uses the default limit of 300 characters", () => {
    const atLimit = ceoPlanText(plan("y".repeat(300)), NOW)!;
    const overLimit = ceoPlanText(plan("y".repeat(301)), NOW)!;
    expect(atLimit).toBe(`CEO plan (no deadline): ${"y".repeat(300)}`);
    expect(overLimit).toBe(`CEO plan (no deadline): ${"y".repeat(299)}…`);
    expect(overLimit.length).toBe(`CEO plan (no deadline): `.length + 300);
  });
});

describe("unexpiredPlan", () => {
  it("holds a ticket only while the deadline is still ahead", () => {
    expect(unexpiredPlan(plan("Split it", FUTURE), NOW)).toBe(true);
  });

  it("does not hold once the deadline is exactly now or has gone", () => {
    expect(unexpiredPlan(plan("Split it", NOW), NOW)).toBe(false);
    expect(unexpiredPlan(plan("Split it", PAST), NOW)).toBe(false);
  });

  it("does not hold without a deadline or without a real plan", () => {
    expect(unexpiredPlan(plan("Split it"), NOW)).toBe(false);
    expect(unexpiredPlan(plan(null, FUTURE), NOW)).toBe(false);
    expect(unexpiredPlan(plan("", FUTURE), NOW)).toBe(false);
    expect(unexpiredPlan(plan("   ", FUTURE), NOW)).toBe(false);
  });
});

describe("leavesPlan", () => {
  it("counts moving out to Blocked or Backlog", () => {
    expect(leavesPlan("in_progress", "blocked")).toBe(true);
    expect(leavesPlan("in_progress", "backlog")).toBe(true);
    expect(leavesPlan("review", "blocked")).toBe(true);
    expect(leavesPlan("ready", "backlog")).toBe(true);
  });

  it("counts going back from In progress to Ready", () => {
    expect(leavesPlan("in_progress", "ready")).toBe(true);
  });

  it("does not count other moves", () => {
    expect(leavesPlan("ready", "in_progress")).toBe(false);
    expect(leavesPlan("in_progress", "review")).toBe(false);
    expect(leavesPlan("ready", "review")).toBe(false);
    expect(leavesPlan("backlog", "ready")).toBe(false);
  });

  it("does not count a move that goes nowhere", () => {
    expect(leavesPlan("blocked", "blocked")).toBe(false);
    expect(leavesPlan("ready", "ready")).toBe(false);
  });
});

describe("urgentBackwards", () => {
  it("counts Review going back to In progress, Blocked or Backlog", () => {
    expect(urgentBackwards("review", "in_progress")).toBe(true);
    expect(urgentBackwards("review", "blocked")).toBe(true);
    expect(urgentBackwards("review", "backlog")).toBe(true);
  });

  it("counts In progress going back to Ready or Backlog", () => {
    expect(urgentBackwards("in_progress", "ready")).toBe(true);
    expect(urgentBackwards("in_progress", "backlog")).toBe(true);
  });

  it("does not count other moves", () => {
    expect(urgentBackwards("review", "ready")).toBe(false);
    expect(urgentBackwards("review", "done")).toBe(false);
    expect(urgentBackwards("in_progress", "blocked")).toBe(false);
    expect(urgentBackwards("in_progress", "review")).toBe(false);
    expect(urgentBackwards("ready", "backlog")).toBe(false);
    expect(urgentBackwards("blocked", "in_progress")).toBe(false);
  });

  it("does not count a move that goes nowhere", () => {
    expect(urgentBackwards("review", "review")).toBe(false);
    expect(urgentBackwards("in_progress", "in_progress")).toBe(false);
  });
});

describe("planMoveWarning", () => {
  it("names the move, the plan, and that the CEO was told", () => {
    expect(planMoveWarning("Split it in two", "in_progress", "blocked", true)).toBe(
      "\n\nHeads up: the CEO set a plan for this ticket that has not expired yet, and in_progress -> blocked leaves it. Split it in two The CEO has been told.",
    );
  });

  it("says nobody else was told when the mover is the CEO", () => {
    expect(planMoveWarning("Split it in two", "ready", "backlog", false)).toBe(
      "\n\nHeads up: the CEO set a plan for this ticket that has not expired yet, and ready -> backlog leaves it. Split it in two You are the CEO, so nobody else was told.",
    );
  });
});

describe("ceoMoveNote", () => {
  const base = {
    title: "Split it in two",
    ref: "BOS-12",
    from: "in_progress",
    to: "blocked",
    mover: "Engineer",
    summary: null as string | null,
    plan: "CEO plan (due 2026-11-16 12:00 UTC): Split it in two" as string | null,
    urgent: false,
  };

  it("names the ticket and the move that left the plan", () => {
    expect(ceoMoveNote(base)).toBe(
      'BOS-12 "Split it in two" moved in_progress -> blocked by Engineer (left its plan).\nCEO plan (due 2026-11-16 12:00 UTC): Split it in two\nDecide whether to leave it or put it back on the plan.',
    );
  });

  it("says when an urgent ticket went backwards instead", () => {
    expect(ceoMoveNote({ ...base, plan: null, urgent: true })).toBe(
      'BOS-12 "Split it in two" moved in_progress -> blocked by Engineer (an urgent ticket went backwards).\nDecide whether to leave it or put it back on the plan.',
    );
  });

  it("names both reasons when the ticket left a plan and went backwards", () => {
    expect(ceoMoveNote({ ...base, urgent: true })).toBe(
      'BOS-12 "Split it in two" moved in_progress -> blocked by Engineer (left its plan; an urgent ticket went backwards).\nCEO plan (due 2026-11-16 12:00 UTC): Split it in two\nDecide whether to leave it or put it back on the plan.',
    );
  });

  it("includes the mover's summary when there is one and leaves it out when there is not", () => {
    expect(ceoMoveNote({ ...base, summary: "waiting on BOS-9" })).toContain("\nEngineer's summary: waiting on BOS-9\n");
    expect(ceoMoveNote({ ...base, summary: "" })).not.toContain("summary");
  });

  it("leaves the ticket ref out when there is none", () => {
    expect(ceoMoveNote({ ...base, ref: null })).toMatch(/^"Split it in two" moved /);
  });
});
