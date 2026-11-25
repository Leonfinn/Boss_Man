// Reading the runner's image stamp and whether a planned swap is under way (BOS-1337): imageAtLeast
// decides whether a past update problem is "Resolved", imageFor picks the one image a history line is
// about, and swapFor decides whether an away runner says "Updating" or "Not connected". The route-level
// cases live in runner-report.test.ts; these pin the edges of the three functions themselves.
import { describe, expect, it } from "vitest";
import { imageAtLeast, imageFor, phaseFor, swapFor } from "../src/services/runner-report.js";
import { midSwap, swapInProgressUntil, type Hold, type LastUpdate } from "../src/services/maintenance.js";

const last = (body: string): LastUpdate => ({ at: "2026-11-04T10:00:00.000Z", startedAt: null, ok: false, title: "Runner update finished with problems", body });
const hold = (extra: Partial<Hold> = {}): Hold => ({ reason: "runner update", since: "2026-11-06T12:00:00.000Z", deadline: "2026-11-06T12:30:00.000Z", minutes: 30, ...extra });

describe("imageAtLeast: is the runner on the image an update installed, or newer", () => {
  it.each([
    ["have is null", null, "20261104"],
    ["have is undefined", undefined, "20261104"],
    ["have is empty", "", "20261104"],
    ["want is null", "20261104", null],
    ["want is undefined", "20261104", undefined],
    ["want is empty", "20261104", ""],
    ["both are null", null, null],
  ])("gives null when %s", (_name, have, want) => {
    expect(imageAtLeast(have, want)).toBeNull();
  });

  it("a newer stamp is true and an equal one is true", () => {
    expect(imageAtLeast("202611040849", "20261104")).toBe(true);
    expect(imageAtLeast("202611040849", "202611040849")).toBe(true);
  });

  it("an older stamp is false", () => {
    expect(imageAtLeast("20261104", "202611040849")).toBe(false);
    expect(imageAtLeast("20261104", "20261105")).toBe(false);
  });

  it("two stamps of different lengths compare as strings: the shorter prefix sorts first", () => {
    expect(imageAtLeast("20261104", "202611040849")).toBe(false);
    expect(imageAtLeast("202611040849", "20261104")).toBe(true);
  });

  it("a stamp with fewer than 8 digits or a word counts only as an exact match", () => {
    expect(imageAtLeast("2026110", "2026110")).toBe(true);
    expect(imageAtLeast("2026110", "202611040849")).toBe(false);
    expect(imageAtLeast("dev", "dev")).toBe(true);
    expect(imageAtLeast("dev", "20261104")).toBe(false);
    expect(imageAtLeast("20261104", "dev")).toBe(false);
  });
});

describe("imageFor: the one image an update's history is about", () => {
  it("gives null with no update at all", () => {
    expect(imageFor(null)).toBeNull();
  });

  it("gives null for a body with no stamp", () => {
    expect(imageFor(last(""))).toBeNull();
    expect(imageFor(last("app-co: has not reconnected"))).toBeNull();
  });

  it("gives the stamp when the body names one, even twice", () => {
    expect(imageFor(last("app-co: image 202611040849 has not reconnected"))).toBe("202611040849");
    expect(imageFor(last("app-co: 202611040849; other-co: 202611040849"))).toBe("202611040849");
  });

  it("gives null when the body names two different stamps", () => {
    expect(imageFor(last("app-co: 20261104; other-co: 20261105"))).toBeNull();
    expect(imageFor(last("app-co: 202611040849; other-co: 202611041200"))).toBeNull();
  });

  it("a 7-digit number is not a stamp", () => {
    expect(imageFor(last("app-co: image 2026110 has not reconnected"))).toBeNull();
  });
});

describe("swapFor: this company's part of the update hold", () => {
  const none = { swap: null, swapFailed: null };

  it("gives no swap and no failure with no hold, no slug, or a wrap-up hold", () => {
    expect(swapFor(null, "app-co")).toEqual(none);
    expect(swapFor(hold({ swapped: { "app-co": "2026-11-06T12:00:00.000Z" } }), undefined)).toEqual(none);
    expect(swapFor(hold({ swapped: { "app-co": "2026-11-06T12:00:00.000Z" } }), "")).toEqual(none);
    expect(swapFor(hold({ kind: "wrapup", swapped: { "app-co": "2026-11-06T12:00:00.000Z" }, tries: { "app-co": { n: 1, next: "2026-11-06T12:01:30.000Z", last: "boom" } }, failed: { "app-co": "boom" } }), "app-co")).toEqual(none);
  });

  it("a failure for this slug wins over its tries and its swapped time", () => {
    const h = hold({
      failed: { "app-co": "the new runner would not start" },
      tries: { "app-co": { n: 2, next: "2026-11-06T12:05:00.000Z", last: "boom" } },
      swapped: { "app-co": "2026-11-06T12:00:00.000Z" },
    });
    expect(swapFor(h, "app-co", Date.parse("2026-11-06T12:01:00.000Z"))).toEqual({ swap: null, swapFailed: "the new runner would not start" });
  });

  it("tries say when the next try is and which try it is", () => {
    const h = hold({ tries: { "app-co": { n: 1, next: "2026-11-06T12:01:30.000Z", last: "boom" } } });
    expect(swapFor(h, "app-co", Date.parse("2026-11-06T12:01:00.000Z"))).toEqual({ swap: { retryAt: "2026-11-06T12:01:30.000Z", tries: 1 }, swapFailed: null });
  });

  it("a swap 4 min 59 s ago is under way, and exactly 5 min ago is not", () => {
    const nowMs = Date.parse("2026-11-06T12:05:00.000Z");
    const under = hold({ swapped: { "app-co": "2026-11-06T12:00:01.000Z" } });
    expect(swapFor(under, "app-co", nowMs)).toEqual({ swap: { retryAt: null, tries: 0 }, swapFailed: null });
    const exactly = hold({ swapped: { "app-co": "2026-11-06T12:00:00.000Z" } });
    expect(swapFor(exactly, "app-co", nowMs)).toEqual(none);
  });

  it("another company's entries are ignored", () => {
    const h = hold({
      failed: { "other-co": "the new runner would not start" },
      tries: { "other-co": { n: 1, next: "2026-11-06T12:01:30.000Z", last: "boom" } },
      swapped: { "other-co": "2026-11-06T12:00:00.000Z" },
    });
    expect(swapFor(h, "app-co", Date.parse("2026-11-06T12:01:00.000Z"))).toEqual(none);
  });
});

// BOS-2533: one rule for "mid-swap", shared by swapFor (live rows), swappingFor (server_status) and swapInProgressUntil.
describe("midSwap: recreated or retrying AND not yet connected", () => {
  const nowMs = Date.parse("2026-11-06T12:02:00.000Z");
  const recent = hold({ swapped: { "app-co": "2026-11-06T12:00:00.000Z" } });
  const retrying = hold({ tries: { "app-co": { n: 1, next: "2026-11-06T12:03:00.000Z", last: "boom" } } });

  it("connected on the new image inside the 5-minute window: not swapping, on every reader", () => {
    expect(midSwap(recent, "app-co", nowMs, true)).toBe(false);
    expect(swapFor(recent, "app-co", nowMs, true)).toEqual({ swap: null, swapFailed: null });
    expect(phaseFor(recent, "app-co", nowMs, true)).toBe("back on new image");
    expect(swapInProgressUntil(recent, new Date(nowMs), 5 * 60_000, () => true)).toBeNull();
  });

  it("not connected inside the window: swapping, on every reader", () => {
    expect(midSwap(recent, "app-co", nowMs, false)).toBe(true);
    expect(swapFor(recent, "app-co", nowMs, false).swap).toEqual({ retryAt: null, tries: 0 });
    expect(phaseFor(recent, "app-co", nowMs, false)).toBe("swapping");
    expect(swapInProgressUntil(recent, new Date(nowMs), 5 * 60_000, () => false)?.toISOString()).toBe("2026-11-06T12:05:00.000Z");
  });

  it("a retry while disconnected is swapping; once connected it is not", () => {
    expect(swapFor(retrying, "app-co", nowMs, false).swap).toEqual({ retryAt: "2026-11-06T12:03:00.000Z", tries: 1 });
    expect(phaseFor(retrying, "app-co", nowMs, false)).toBe("swapping");
    expect(swapFor(retrying, "app-co", nowMs, true).swap).toBeNull();
    expect(phaseFor(retrying, "app-co", nowMs, true)).toBe("back on new image");
  });

  it("phase: waiting for runs before its recreate, failed on a failure, none for a wrap-up hold or no hold", () => {
    expect(phaseFor(hold(), "app-co", nowMs, true)).toBe("waiting for runs");
    expect(phaseFor(hold({ failed: { "app-co": "boom" } }), "app-co", nowMs, false)).toBe("failed");
    expect(phaseFor(hold({ kind: "wrapup" }), "app-co", nowMs, false)).toBeNull();
    expect(phaseFor(null, "app-co", nowMs, false)).toBeNull();
    expect(phaseFor(recent, "app-co", Date.parse("2026-11-06T12:06:00.000Z"), false)).toBeNull();
  });
});
