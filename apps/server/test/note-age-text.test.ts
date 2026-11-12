// The age line shown next to an agent's notes (BOS-1235): "set 9 Nov, 6 d ago", the owner's
// review-by day, and "review due" once a note is past its review day or untouched too long.
// Every date here is fixed and passed as `at`; the real clock never decides a case (BOS-1183).
import { describe, expect, it } from "vitest";
import { ageText, STALE_NOTE_DAYS } from "../src/services/agent-notes.js";

const at = (iso: string) => new Date(iso);

describe("ageText", () => {
  it("shows today for a note set earlier the same day", () => {
    expect(ageText({ updatedAt: at("2026-11-12T08:00:00Z") }, at("2026-11-12T20:00:00Z"))).toBe("set 12 Nov, today");
  });

  it("shows the whole days since a note was set", () => {
    expect(ageText({ updatedAt: at("2026-11-06T12:00:00Z") }, at("2026-11-12T12:00:00Z"))).toBe("set 6 Nov, 6 d ago");
  });

  it("adds the review-by day, before that day comes, without marking it due", () => {
    const text = ageText({ updatedAt: at("2026-11-12T08:00:00Z"), reviewBy: "2026-11-20" }, at("2026-11-12T20:00:00Z"));
    expect(text).toBe("set 12 Nov, today; review by 20 Nov");
    expect(text).not.toContain("review due");
  });

  it("marks a note due once its review-by day has passed", () => {
    const text = ageText({ updatedAt: at("2026-11-12T08:00:00Z"), reviewBy: "2026-11-10" }, at("2026-11-12T20:00:00Z"));
    expect(text).toBe("set 12 Nov, today; review by 10 Nov; review due: past its review-by date");
  });

  it("marks a note with no review-by due at exactly the stale limit, not a day before", () => {
    const stale = ageText({ updatedAt: at("2026-10-13T12:00:00Z") }, at("2026-11-12T12:00:00Z"));
    expect(stale).toBe(`set 13 Oct, ${STALE_NOTE_DAYS} d ago; review due: untouched for ${STALE_NOTE_DAYS} days`);
    const fresh = ageText({ updatedAt: at("2026-10-14T12:00:00Z") }, at("2026-11-12T12:00:00Z"));
    expect(fresh).toBe(`set 14 Oct, ${STALE_NOTE_DAYS - 1} d ago`);
    expect(fresh).not.toContain("review due");
  });

  it("shows today, not a negative age, when a note's updatedAt is after `at` (clock skew)", () => {
    expect(ageText({ updatedAt: at("2026-11-12T14:00:00Z") }, at("2026-11-12T10:00:00Z"))).toBe("set 12 Nov, today");
  });

  it("names the month in UTC, so a late-evening UTC set does not roll to the next day", () => {
    expect(ageText({ updatedAt: at("2026-10-31T23:30:00Z") }, at("2026-11-12T00:00:00Z"))).toMatch(/^set 31 Oct, /);
  });
});
