// metricValue and metricSample read one number and its sample size out of a scorecard (docs/19 part 3).
// They are pure, so a hand-made scorecard object is enough: no database here.
import { describe, expect, it } from "vitest";
import { metricSample, metricValue } from "../src/services/workflow.js";

type Scorecard = Parameters<typeof metricValue>[0];

const H = 3_600_000;

/** Only the fields the two helpers read matter; the rest of the scorecard is not touched. */
function scorecard(): Scorecard {
  return {
    byRole: [
      { role: "developer", done: 4, medianCycleMs: 2 * H },
      { role: "reviewer", done: 6, medianCycleMs: null },
    ],
    byAgent: [{ agentId: "agent-1", done: 2, medianCycleMs: 3 * H }],
    handoffs: [
      { from: "developer", to: "reviewer", kind: "review", count: 5, medianWaitMs: 1_000, bounceRate: 0.4 },
      { from: "owner", to: "developer", kind: "assign", count: 1, medianWaitMs: 500, bounceRate: null },
    ],
    features: [{ tailLagMs: 10 * H }, { tailLagMs: null }, { tailLagMs: 30 * H }, { tailLagMs: 20 * H }],
  } as unknown as Scorecard;
}

describe("metricValue", () => {
  it("takes the median tail lag over features, skipping null ones", () => {
    expect(metricValue(scorecard(), "tailLagMs", {})).toBe(20 * H);
    // Every lag null (or no features) leaves nothing to measure.
    const none = { ...scorecard(), features: [{ tailLagMs: null }] } as unknown as Scorecard;
    expect(metricValue(none, "tailLagMs", {})).toBeNull();
  });

  it("finds the handoff by from, to and kind", () => {
    const sc = scorecard();
    expect(metricValue(sc, "medianWaitMs", { from: "developer", to: "reviewer", kind: "review" })).toBe(1_000);
    expect(metricValue(sc, "bounceRate", { from: "developer", to: "reviewer", kind: "review" })).toBe(0.4);
    // An assign handoff has no bounce rate, only a wait.
    expect(metricValue(sc, "bounceRate", { from: "owner", to: "developer", kind: "assign" })).toBeNull();
    expect(metricValue(sc, "medianWaitMs", { from: "owner", to: "developer", kind: "assign" })).toBe(500);
  });

  it("returns null when the handoff does not match", () => {
    const sc = scorecard();
    expect(metricValue(sc, "medianWaitMs", { from: "developer", to: "reviewer", kind: "assign" })).toBeNull();
    expect(metricValue(sc, "medianWaitMs", { from: "reviewer", to: "developer", kind: "review" })).toBeNull();
    expect(metricValue(sc, "bounceRate", { from: "nobody", to: "reviewer", kind: "review" })).toBeNull();
  });

  it("reads a per-agent metric with scope.agentId", () => {
    expect(metricValue(scorecard(), "medianCycleMs", { agentId: "agent-1" })).toBe(3 * H);
    expect(metricValue(scorecard(), "done", { agentId: "agent-1" })).toBe(2);
    // Unknown agent: no row.
    expect(metricValue(scorecard(), "medianCycleMs", { agentId: "agent-2" })).toBeNull();
  });

  it("reads a per-role metric with scope.role", () => {
    expect(metricValue(scorecard(), "done", { role: "developer" })).toBe(4);
    // A row that exists but has no value for the metric.
    expect(metricValue(scorecard(), "medianCycleMs", { role: "reviewer" })).toBeNull();
    // A metric the row does not carry at all.
    expect(metricValue(scorecard(), "meanRework", { role: "developer" })).toBeNull();
    // Unknown role: no row.
    expect(metricValue(scorecard(), "done", { role: "nobody" })).toBeNull();
  });
});

describe("metricSample", () => {
  it("counts all finished tickets for a tail measure", () => {
    // 4 + 6, the done counts across every role row.
    expect(metricSample(scorecard(), "tailLagMs", {})).toBe(10);
  });

  it("counts the matching handoff's samples, or zero when none matches", () => {
    const sc = scorecard();
    expect(metricSample(sc, "medianWaitMs", { from: "developer", to: "reviewer", kind: "review" })).toBe(5);
    expect(metricSample(sc, "bounceRate", { from: "owner", to: "developer", kind: "assign" })).toBe(1);
    expect(metricSample(sc, "medianWaitMs", { from: "developer", to: "reviewer", kind: "assign" })).toBe(0);
    expect(metricSample(sc, "medianWaitMs", { from: "nobody", to: "reviewer", kind: "review" })).toBe(0);
  });

  it("counts the agent's or role's done tickets, or zero when the row is missing", () => {
    expect(metricSample(scorecard(), "medianCycleMs", { agentId: "agent-1" })).toBe(2);
    expect(metricSample(scorecard(), "medianCycleMs", { agentId: "agent-2" })).toBe(0);
    expect(metricSample(scorecard(), "done", { role: "developer" })).toBe(4);
    expect(metricSample(scorecard(), "done", { role: "nobody" })).toBe(0);
  });
});
