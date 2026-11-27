// BOS-2748: the pure output helpers agents' ticket/roadmap lookups use — a ticket's size and milestone as they are
// shown, and the owner-notice key for a host warning. No database is opened: importing these modules must not need one.
import { describe, expect, it } from "vitest";
import { effectiveSize } from "../src/services/planning.js";
import { milestoneOut, sizeOut } from "../src/mcp-ticket-plan.js";
import { hostWarningAlertKey, hostWarningOwnerKey } from "../src/services/host-warnings.js";

describe("sizeOut", () => {
  it("shows a real size as rounded points", () => {
    expect(sizeOut(3)).toBe(3);
    expect(sizeOut(2.6)).toBe(3);
  });

  it("shows a size that is not real as no size", () => {
    expect(sizeOut(0)).toBe("no size");
    expect(sizeOut(-1)).toBe("no size");
    expect(sizeOut(null)).toBe("no size");
    expect(sizeOut(undefined)).toBe("no size");
    expect(sizeOut(Number.NaN)).toBe("no size");
  });

  it("agrees with effectiveSize on every case", () => {
    for (const size of [3, 2.6, 1, 0, -1, null, undefined, Number.NaN, 0.4, 8]) {
      const effective = effectiveSize(size);
      expect(sizeOut(size)).toBe(effective >= 1 ? effective : "no size");
    }
  });
});

describe("milestoneOut", () => {
  it("shows a milestone's id and title", () => {
    expect(milestoneOut("m1", "Beta")).toEqual({ id: "m1", title: "Beta" });
  });

  it("falls back to an empty title when one is missing", () => {
    expect(milestoneOut("m1", null)).toEqual({ id: "m1", title: "" });
    expect(milestoneOut("m1", undefined)).toEqual({ id: "m1", title: "" });
  });

  it("is null when there is no milestone id", () => {
    expect(milestoneOut(null, "Beta")).toBeNull();
    expect(milestoneOut(undefined, "Beta")).toBeNull();
    expect(milestoneOut("", "Beta")).toBeNull();
  });
});

describe("hostWarningOwnerKey", () => {
  it("names the owner-notice key for a host warning", () => {
    expect(hostWarningOwnerKey("check.container_status.app")).toBe("alert:host-warning-owner:check.container_status.app");
  });

  it("differs from the CEO alert key for the same warning", () => {
    const key = "check.container_status.app";
    expect(hostWarningOwnerKey(key)).not.toBe(hostWarningAlertKey(key));
    expect(hostWarningAlertKey(key)).toBe("alert:host-warning:check.container_status.app");
  });
});
