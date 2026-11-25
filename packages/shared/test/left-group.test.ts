import { describe, expect, it } from "vitest";
import { leftGroup } from "../src/index.js";

// BOS-2580: which "What's left" group a ticket sits in; first match wins, so each ticket is in exactly one.
const none = { delivered: false, quiet: false, stuck: false, ownerCard: false, held: false };
describe("leftGroup", () => {
  it("sorts a ticket by what holds it", () => {
    expect(leftGroup({ ...none, ownerCard: true, held: true, stuck: true })).toBe("owner");
    expect(leftGroup({ ...none, stuck: true, held: true })).toBe("look");
    expect(leftGroup({ ...none, held: true })).toBe("held");
    expect(leftGroup(none)).toBe("building");
  });
  it("treats a live ticket as a final check: Running, or Needs a look once quiet, whatever else is recorded", () => {
    expect(leftGroup({ ...none, delivered: true })).toBe("running");
    expect(leftGroup({ ...none, delivered: true, quiet: true })).toBe("look");
    expect(leftGroup({ ...none, delivered: true, ownerCard: true })).toBe("running");
  });
});
