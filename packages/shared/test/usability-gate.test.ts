import { describe, expect, it } from "vitest";
import { acceptanceCriteriaSchema, missingVerdicts } from "../src/acceptance.js";
import {
  addsUsabilityCriterion,
  isUsabilityCriterion,
  needsUsabilityGate,
  realUseWalkthrough,
  recurringDutyHits,
  recurringDutyInDiff,
  touchesInstallSurface,
  usabilityGated,
  USABILITY_CRITERION,
  withUsabilityCriterion,
} from "../src/usability-gate.js";

// BOS-1571: which tickets carry the usability gate, how a reviewer's walk-through is read, and the
// tripwire for wording that hands the owner a routine duty (the check worker's docs said "Do this
// soon: until then the worker is idle", and five reviews read it without asking how often).

describe("which tickets carry the usability gate", () => {
  it("a feature's ticket and a ticket with owner setup steps do; a plain or no-code ticket doesn't", () => {
    expect(needsUsabilityGate({ featureId: "f1" })).toBe(true);
    expect(needsUsabilityGate({ ownerSetup: "Settings → Checks → turn on" })).toBe(true);
    expect(needsUsabilityGate({})).toBe(false);
    expect(needsUsabilityGate({ ownerSetup: "   " })).toBe(false);
    expect(needsUsabilityGate({ featureId: "f1", noCode: true })).toBe(false);
  });

  it("adds the built-in criterion once, and counts a hand-written one", () => {
    expect(withUsabilityCriterion(["works"], { featureId: "f1" })).toEqual(["works", USABILITY_CRITERION]);
    expect(withUsabilityCriterion(["works"], {})).toEqual(["works"]);
    const byHand = "USABILITY GATE (applies to this ticket too): walk through day 1 and a week on";
    expect(isUsabilityCriterion(byHand)).toBe(true);
    expect(withUsabilityCriterion([byHand], { featureId: "f1" })).toEqual([byHand]);
    expect(withUsabilityCriterion([USABILITY_CRITERION], { featureId: "f1" })).toEqual([USABILITY_CRITERION]);
    expect(addsUsabilityCriterion([], { featureId: "f1" })).toBe(true);
    expect(addsUsabilityCriterion([USABILITY_CRITERION], { featureId: "f1" })).toBe(false);
  });

  it("never pushes a ticket past the 10-criterion cap, and the built-in one is a valid criterion", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `criterion ${i}`);
    expect(withUsabilityCriterion(ten, { featureId: "f1" })).toEqual(ten);
    expect(acceptanceCriteriaSchema.safeParse(withUsabilityCriterion([], { featureId: "f1" })).success).toBe(true);
  });

  it("a numbered verdict reports it like any criterion", () => {
    const criteria = withUsabilityCriterion(["the page loads"], { featureId: "f1" });
    expect(missingVerdicts(criteria, "1 pass", "before")).toEqual([USABILITY_CRITERION]);
    expect(missingVerdicts(criteria, "1 pass; 2 pass", "before")).toEqual([]);
  });

  it("the review gate also covers a change to what the owner installs, outside any feature", () => {
    expect(touchesInstallSurface(["docker-compose.check-worker.yml"])).toBe(true);
    expect(touchesInstallSurface(["deploy/host.yml"])).toBe(true);
    expect(touchesInstallSurface(["apps/runner/Dockerfile"])).toBe(true);
    expect(touchesInstallSurface(["docs/26-check-workers.md"])).toBe(true);
    expect(touchesInstallSurface(["apps/web/src/pages/Board.tsx", "docs/10-migrations.md"])).toBe(false);
    expect(usabilityGated({}, ["apps/server/src/app.ts"])).toBe(false);
    expect(usabilityGated({}, ["deploy/host.yml"])).toBe(true);
    expect(usabilityGated({ acceptanceCriteria: ["Usability gate: by hand"] })).toBe(true);
    expect(usabilityGated({ featureId: "f1" })).toBe(true);
  });
});

describe("a reviewer's real-use walk-through", () => {
  it("is the text after a Real use: label, long enough to say something", () => {
    const said = "after a runner update it carries on with no owner step; nothing to repeat.";
    expect(realUseWalkthrough(`Code is fine.\nReal use: ${said}`)).toBe(said);
    expect(realUseWalkthrough(`real-use: ${said}`)).toBe(said);
    expect(realUseWalkthrough("Real use: fine")).toBeNull();
    expect(realUseWalkthrough("Looks good, approved.")).toBeNull();
    expect(realUseWalkthrough(null)).toBeNull();
    // The one-line form the refusal offers for a change the owner never sees is long enough.
    expect(realUseWalkthrough("Real use: tests only; nothing the owner runs, sees or repeats changes.")).not.toBeNull();
  });
});

describe("the recurring-duty tripwire", () => {
  it("flags the check worker's own sentence and its kin", () => {
    expect(recurringDutyHits("Do this soon: until then the worker is idle.")).toHaveLength(1);
    expect(recurringDutyHits("After every runner update, rebuild the worker.")).toHaveLength(1);
    expect(recurringDutyHits("Until then it stays idle and takes no jobs.")).toHaveLength(1);
    expect(recurringDutyHits("Each time the runner updates, paste the new commit.")).toHaveLength(1);
    expect(recurringDutyHits("The owner must clear the queue every day.")).toHaveLength(1);
    expect(recurringDutyHits("Remember to restart it.")).toHaveLength(1);
  });

  it("leaves one-off setup and ordinary text alone", () => {
    expect(recurringDutyHits("Settings → Checks → turn on Check workers.\nCopy the compose file and run it once.")).toEqual([]);
    expect(recurringDutyHits("The worker updates itself after a runner update.")).toEqual([]);
    expect(recurringDutyHits("")).toEqual([]);
  });

  it("finds the added lines in a diff with their file and line", () => {
    const diff = [
      "diff --git a/docs/26-check-workers.md b/docs/26-check-workers.md",
      "--- a/docs/26-check-workers.md",
      "+++ b/docs/26-check-workers.md",
      "@@ -10,3 +10,4 @@",
      " ## Update a worker",
      "-Old text: until then the worker is idle.",
      "+Paste the commit into compose.yaml.",
      "+Do this soon: until then the worker is idle.",
      " Done.",
    ].join("\n");
    expect(recurringDutyInDiff(diff)).toEqual([{ path: "docs/26-check-workers.md", line: 12, text: "Do this soon: until then the worker is idle." }]);
  });
});
