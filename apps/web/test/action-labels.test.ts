import { WATCHDOG_ACTIONS, WATCHDOG_ACTION_LABEL } from "@boss-man/shared";
import { describe, expect, it } from "vitest";
import { actionHeading } from "../src/components/ScrumMasterLog";

describe("Scrum Master log labels", () => {
  it("has a plain-English label for every action kind the owner can see", () => {
    for (const kind of WATCHDOG_ACTIONS) {
      const label = WATCHDOG_ACTION_LABEL[kind];
      expect(label, kind).toBeTruthy();
      expect(label, kind).not.toMatch(/_/);
    }
    expect(Object.keys(WATCHDOG_ACTION_LABEL).sort()).toEqual([...WATCHDOG_ACTIONS].sort());
  });

  it("says who a warning was passed to and which warning it was", () => {
    expect(actionHeading({ kind: "alert_hop", targetName: "Sam", targetIsCeo: true, targetIsScrumMaster: false, warning: "Review looks stuck" })).toBe("Warning passed to the CEO (Sam): Review looks stuck");
    expect(actionHeading({ kind: "alert_hop", targetName: null, warning: null })).toBe("Warning passed to you");
  });

  it("never shows a raw name for an unknown kind", () => {
    expect(actionHeading({ kind: "brand_new_thing" })).not.toMatch(/_/);
  });
});
