import { describe, expect, it } from "vitest";
import { inForceHeadline, inForceReason, type LimitInForce } from "../src/limit-in-force";

// BOS-1634: a limit saved by the owner and the lower one the scheduler enforces while a
// server update waits. Both the Settings panel and the dashboard word it with these helpers.

const held: LimitInForce = {
  saved: 16,
  inForce: 3,
  because: "a server update is waiting for a quiet machine",
  since: "2026-11-16T10:00:00.000Z",
  until: "2026-11-16T13:00:00.000Z",
};

// The reason prints a time in the reader's own locale and timezone, so ask the same
// formatter for the expected time instead of hard-coding one machine's words.
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

describe("the saved-and-in-force headline", () => {
  it("says both numbers and that the lower one lasts until the update goes in", () => {
    expect(inForceHeadline(held)).toBe("Saved 16 · in force 3 until the update goes in");
  });

  it("shows nothing when there is no limit object", () => {
    expect(inForceHeadline(null)).toBeNull();
    expect(inForceHeadline(undefined)).toBeNull();
  });

  it("shows nothing when the server gave no reason, even if the numbers differ", () => {
    expect(inForceHeadline({ ...held, because: null })).toBeNull();
  });

  it("shows nothing when the number in force is the saved one", () => {
    expect(inForceHeadline({ ...held, inForce: 16 })).toBeNull();
  });

  it("shows nothing when the number in force is higher than the saved one", () => {
    expect(inForceHeadline({ ...held, inForce: 20 })).toBeNull();
  });

  it("still shows a hold that drops the limit to zero", () => {
    expect(inForceHeadline({ ...held, inForce: 0 })).toBe("Saved 16 · in force 0 until the update goes in");
  });
});

describe("the sentence explaining a lower limit", () => {
  it("gives the reason, since when, the latest it lifts, and that the owner need change nothing", () => {
    expect(inForceReason(held)).toBe(
      `Lower because a server update is waiting for a quiet machine since ${clock(held.since!)}. ` +
        `It goes back to 16 by ${clock(held.until!)} at the latest. ` +
        "Nothing to change: runs already going carry on, and your number comes back by itself.",
    );
  });

  it("leaves out the start time when the server did not send one", () => {
    const reason = inForceReason({ ...held, since: null });
    expect(reason).toBe(
      `Lower because a server update is waiting for a quiet machine. ` +
        `It goes back to 16 by ${clock(held.until!)} at the latest. ` +
        "Nothing to change: runs already going carry on, and your number comes back by itself.",
    );
    expect(reason).not.toContain("since ");
  });

  it("leaves out the latest lift time when the server did not send one", () => {
    const reason = inForceReason({ ...held, until: null });
    expect(reason).toBe(
      `Lower because a server update is waiting for a quiet machine since ${clock(held.since!)}. ` +
        "Nothing to change: runs already going carry on, and your number comes back by itself.",
    );
    expect(reason).not.toContain("goes back to");
  });

  it("still says there is nothing to change when it has neither a start nor a lift time", () => {
    const reason = inForceReason({ ...held, since: null, until: null });
    expect(reason).toBe(
      "Lower because a server update is waiting for a quiet machine. " +
        "Nothing to change: runs already going carry on, and your number comes back by itself.",
    );
  });

  it("uses the saved number in its 'goes back to' promise, not the number in force", () => {
    expect(inForceReason({ ...held, saved: 10, inForce: 2 })).toContain("It goes back to 10 by");
  });
});
