// BOS-1316: which roadmap column a feature sits in. Pins today's rules: a released feature always
// sits in Released, a pinned column beats the status, and otherwise the status decides.
import { describe, expect, it } from "vitest";
import { FEATURE_STATUSES, featureHorizon, type FeatureStatus } from "../src/index.js";

// The column each status falls into when nobody has pinned one. A status missing here is a clear
// failure in the exhaustive test below, so a new status can't be added without deciding its column.
const UNPINNED: Record<FeatureStatus, "now" | "next" | "later" | "released"> = {
  idea: "later",
  considering: "later",
  planned: "next",
  in_progress: "now",
  released: "released",
  // Pinned as today's behaviour: an unpinned declined feature falls into Later. The roadmap does not
  // show declined features (the server drops them before the board), so this is not a visible bug.
  declined: "later",
};

describe("featureHorizon", () => {
  it("puts released features in Released even when a column is pinned", () => {
    expect(featureHorizon({ status: "released", horizon: null })).toBe("released");
    for (const horizon of ["now", "next", "later"] as const) expect(featureHorizon({ status: "released", horizon })).toBe("released");
  });

  it("lets a pinned column win over the status", () => {
    expect(featureHorizon({ status: "planned", horizon: "later" })).toBe("later");
    expect(featureHorizon({ status: "idea", horizon: "now" })).toBe("now");
    expect(featureHorizon({ status: "in_progress", horizon: "next" })).toBe("next");
    expect(featureHorizon({ status: "considering", horizon: "later" })).toBe("later");
  });

  it("follows the status when nothing is pinned", () => {
    expect(featureHorizon({ status: "in_progress", horizon: null })).toBe("now");
    expect(featureHorizon({ status: "planned", horizon: null })).toBe("next");
    expect(featureHorizon({ status: "idea", horizon: null })).toBe("later");
    expect(featureHorizon({ status: "considering", horizon: null })).toBe("later");
  });

  it("gives a declined feature with no pin Later, today's behaviour", () => {
    expect(featureHorizon({ status: "declined", horizon: null })).toBe("later");
  });

  it("has a decided unpinned column for every status", () => {
    for (const status of FEATURE_STATUSES) {
      const expected = UNPINNED[status];
      if (!expected) throw new Error(`No unpinned column decided for feature status "${status}": add it to UNPINNED in this test`);
      expect(featureHorizon({ status, horizon: null }), `status "${status}" with no pinned column`).toBe(expected);
    }
  });

  it("keeps a status pinned to each column in that column, except released", () => {
    for (const status of FEATURE_STATUSES) {
      for (const horizon of ["now", "next", "later"] as const) {
        expect(featureHorizon({ status, horizon }), `status "${status}" pinned to "${horizon}"`).toBe(status === "released" ? "released" : horizon);
      }
    }
  });
});
