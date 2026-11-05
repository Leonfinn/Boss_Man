import { describe, expect, it } from "vitest";
import { planFirstText } from "./scheduler.js";

describe("plan-first wake text by harness (BOS-531)", () => {
  it("tells Claude Code to use ExitPlanMode", () => {
    expect(planFirstText("claude")).toContain("ExitPlanMode");
  });
  it("tells OpenCode there is no ExitPlanMode and to raise a decision with the plan", () => {
    const t = planFirstText("opencode");
    expect(t).toContain("no plan mode or ExitPlanMode");
    expect(t).not.toContain("present your plan with ExitPlanMode");
    expect(t).toContain("raise_decision");
  });
});
