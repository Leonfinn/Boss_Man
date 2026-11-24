// BOS-2521: what a feature is still missing (a size, a roadmap place, a portal decision), and the tags that name it.
import { describe, expect, it } from "vitest";
import { SETUP_GAP_LABEL, setupGaps } from "../src/pages/Features";

const f = (over: Partial<{ effort: number | null; objectiveId: string | null; milestoneId: string | null; portalVisible: boolean; keepOffPortal: boolean }>) => ({
  effort: 3,
  objectiveId: "o1",
  milestoneId: null,
  portalVisible: true,
  keepOffPortal: false,
  ...over,
});

describe("setupGaps", () => {
  it("finds nothing on a feature that is sized, placed and decided", () => {
    expect(setupGaps(f({}))).toEqual([]);
  });

  it("names each missing piece in order", () => {
    expect(setupGaps(f({ effort: null, objectiveId: null, portalVisible: false }))).toEqual(["size", "roadmap", "portal"]);
  });

  it("counts a milestone, or an objective, as a place on the roadmap", () => {
    expect(setupGaps(f({ objectiveId: null, milestoneId: "m1" }))).toEqual([]);
    expect(setupGaps(f({ objectiveId: "o1", milestoneId: null }))).toEqual([]);
    expect(setupGaps(f({ objectiveId: null, milestoneId: null }))).toEqual(["roadmap"]);
  });

  it("counts being kept off the portal as a portal decision, and unticking it as not decided", () => {
    expect(setupGaps(f({ portalVisible: false, keepOffPortal: true }))).toEqual([]);
    expect(setupGaps(f({ portalVisible: false, keepOffPortal: false }))).toEqual(["portal"]);
    expect(setupGaps(f({ portalVisible: true, keepOffPortal: true }))).toEqual([]);
  });

  it("has a short tag for each gap", () => {
    expect(SETUP_GAP_LABEL).toEqual({ size: "No size", roadmap: "Not on the roadmap", portal: "Portal not decided" });
  });
});
