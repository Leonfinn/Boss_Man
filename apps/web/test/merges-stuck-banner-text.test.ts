import { describe, expect, it } from "vitest";
import {
  heldSummary,
  heldText,
  slowSummary,
  slowText,
  stuckSummary,
  waitedText,
  type HeldFix,
  type MergeHealthView,
  type MergeLine,
} from "../src/components/MergesStuckBanner";

// BOS-1765: the plain-word helpers behind the merge-line banner (BOS-1507, BOS-1594, BOS-1652).
// The server decides the line's state; these functions only turn that verdict into the owner's words.

const view = (line?: MergeLine): Pick<MergeHealthView, "line"> => (line ? { line } : {});

// The functions print the time with the viewer's own locale and timezone, so the test asks the
// same runtime for the expected words instead of hard-coding a clock.
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const fix = (over: Partial<HeldFix> = {}): HeldFix => ({
  ticketId: "00000000-0000-4000-8000-000000000001",
  ref: "BOS-100",
  title: "Fix the merge check",
  stateText: "being fixed",
  ownerUpdate: false,
  ...over,
});

describe("waitedText", () => {
  it("says minutes under an hour", () => {
    expect(waitedText(0)).toBe("0 min");
    expect(waitedText(1)).toBe("1 min");
    expect(waitedText(45)).toBe("45 min");
    expect(waitedText(59)).toBe("59 min");
  });

  it("drops the minutes on the hour", () => {
    expect(waitedText(60)).toBe("1 h");
    expect(waitedText(120)).toBe("2 h");
    expect(waitedText(1440)).toBe("24 h");
  });

  it("keeps both parts when there are minutes over the hour", () => {
    expect(waitedText(61)).toBe("1 h 1 min");
    expect(waitedText(80)).toBe("1 h 20 min");
    expect(waitedText(255)).toBe("4 h 15 min");
  });
});

describe("heldSummary", () => {
  it("is null when there is no read, no line, or any other verdict", () => {
    expect(heldSummary(null)).toBeNull();
    expect(heldSummary(undefined)).toBeNull();
    expect(heldSummary(view())).toBeNull();
    expect(heldSummary(view({ state: "healthy" }))).toBeNull();
    expect(heldSummary(view({ state: "over_capacity", waiting: 2, etaMinutes: null, lastLandedAt: null, advice: null }))).toBeNull();
    expect(heldSummary(view({ state: "stuck", cause: "gate_fault", title: "t", reason: "r", fix: "f", others: 0 }))).toBeNull();
  });

  it("copies the held verdict's three fields", () => {
    const fixes = [fix()];
    expect(heldSummary(view({ state: "held_behind_fix", held: 2, fixes, since: "2026-11-17T10:00:00.000Z" }))).toEqual({
      held: 2,
      fixes,
      since: "2026-11-17T10:00:00.000Z",
    });
    expect(heldSummary(view({ state: "held_behind_fix", held: 1, fixes: [], since: null }))).toEqual({ held: 1, fixes: [], since: null });
  });
});

describe("heldText", () => {
  const endByItself = "They merge by themselves once it is merged and live.";
  const endOnUpdate = "They go on once the server update runs.";

  it("says one ticket in the singular, by ref", () => {
    expect(heldText({ held: 1, fixes: [fix()], since: null })).toBe(
      `Main is red: 1 approved ticket is held behind the fix BOS-100 (being fixed). ${endByItself}`,
    );
  });

  it("says several tickets in the plural, joined with and", () => {
    const fixes = [fix(), fix({ ticketId: "00000000-0000-4000-8000-000000000002", ref: "BOS-101", stateText: "approved" })];
    expect(heldText({ held: 3, fixes, since: null })).toBe(
      `Main is red: 3 approved tickets are held behind the fix BOS-100 (being fixed) and BOS-101 (approved). ${endByItself}`,
    );
  });

  it("quotes the title when the fix has no ref, and uses the update wording for an owner update", () => {
    expect(heldText({ held: 1, fixes: [fix({ ref: null, title: "Repair the gate", ownerUpdate: true })], since: null })).toBe(
      `Main is red: 1 approved ticket is held behind the fix "Repair the gate" (being fixed). ${endOnUpdate}`,
    );
  });

  it("adds the start time when there is one", () => {
    const since = "2026-11-17T10:00:00.000Z";
    expect(heldText({ held: 1, fixes: [fix()], since })).toBe(
      `Main is red: 1 approved ticket is held behind the fix BOS-100 (being fixed), since ${clock(since)}. ${endByItself}`,
    );
  });
});

describe("stuckSummary", () => {
  it("copies the stuck verdict and nothing else", () => {
    expect(stuckSummary({ line: { state: "stuck", cause: "gate_fault", title: "BOS-10 waits", reason: "no runner", fix: "start it", others: 2 } })).toEqual({
      title: "BOS-10 waits",
      reason: "no runner",
      fix: "start it",
      others: 2,
    });
  });

  it("is null for a healthy, slow or held line, or no line", () => {
    expect(stuckSummary({})).toBeNull();
    expect(stuckSummary({ line: { state: "healthy" } })).toBeNull();
    expect(stuckSummary({ line: { state: "over_capacity", waiting: 1, etaMinutes: null, lastLandedAt: null, advice: null } })).toBeNull();
    expect(stuckSummary({ line: { state: "held_behind_fix", held: 1, fixes: [], since: null } })).toBeNull();
  });
});

describe("slowSummary", () => {
  it("copies the over-capacity verdict and nothing else", () => {
    expect(slowSummary({ line: { state: "over_capacity", waiting: 17, etaMinutes: 255, lastLandedAt: "2026-11-15T19:03:00.000Z", advice: "add a worker" } })).toEqual({
      waiting: 17,
      etaMinutes: 255,
      lastLandedAt: "2026-11-15T19:03:00.000Z",
      advice: "add a worker",
    });
  });

  it("is null for a healthy, stuck or held line, or no line", () => {
    expect(slowSummary({})).toBeNull();
    expect(slowSummary({ line: { state: "healthy" } })).toBeNull();
    expect(slowSummary({ line: { state: "stuck", cause: "gate_fault", title: "t", reason: "r", fix: "f", others: 0 } })).toBeNull();
    expect(slowSummary({ line: { state: "held_behind_fix", held: 1, fixes: [], since: null } })).toBeNull();
  });
});

describe("slowText", () => {
  const base = { waiting: 17, etaMinutes: null, lastLandedAt: null, advice: null };

  it("says one check in the singular", () => {
    expect(slowText({ ...base, waiting: 1 })).toBe("Merging, but slowly: 1 merge check waiting.");
  });

  it("says several checks in the plural, and zero too", () => {
    expect(slowText(base)).toBe("Merging, but slowly: 17 merge checks waiting.");
    expect(slowText({ ...base, waiting: 0 })).toBe("Merging, but slowly: 0 merge checks waiting.");
  });

  it("adds the time to clear when there is an estimate", () => {
    expect(slowText({ ...base, etaMinutes: 255 })).toBe(
      "Merging, but slowly: 17 merge checks waiting, about 4 h 15 min to clear at the current rate.",
    );
    expect(slowText({ ...base, waiting: 1, etaMinutes: 0 })).toBe(
      "Merging, but slowly: 1 merge check waiting, about 0 min to clear at the current rate.",
    );
  });

  it("adds when the line last landed, using the viewer's clock", () => {
    const lastLandedAt = "2026-11-15T19:03:00.000Z";
    expect(slowText({ ...base, lastLandedAt })).toBe(
      `Merging, but slowly: 17 merge checks waiting, last landed ${clock(lastLandedAt)}.`,
    );
  });

  it("puts the estimate before the last landing", () => {
    const lastLandedAt = "2026-11-15T19:03:00.000Z";
    expect(slowText({ ...base, etaMinutes: 45, lastLandedAt })).toBe(
      `Merging, but slowly: 17 merge checks waiting, about 45 min to clear at the current rate, last landed ${clock(lastLandedAt)}.`,
    );
  });
});
