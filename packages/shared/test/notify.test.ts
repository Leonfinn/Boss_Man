import { describe, expect, it } from "vitest";
import { demote, effectiveLevel, inQuietHours } from "../src/notify.js";

describe("notification ladder (R44)", () => {
  it("demotes one step at a time and never drops", () => {
    expect([demote("ask"), demote("page"), demote("flag"), demote("note")]).toEqual(["flag", "flag", "note", "note"]);
  });

  it("reads quiet hours in their own time zone, including ranges over midnight", () => {
    const quiet = { start: "22:00", end: "07:00", timeZone: "Europe/London" };
    // 16 Oct 2026 is BST (UTC+1): 21:30 UTC is 22:30 in London.
    expect(inQuietHours(new Date("2026-10-16T21:30:00Z"), quiet)).toBe(true);
    expect(inQuietHours(new Date("2026-10-16T20:30:00Z"), quiet)).toBe(false);
    expect(inQuietHours(new Date("2026-10-17T05:59:00Z"), quiet)).toBe(true);
    expect(inQuietHours(new Date("2026-10-17T06:00:00Z"), quiet)).toBe(false);
    // A daytime range doesn't wrap.
    expect(inQuietHours(new Date("2026-10-16T12:00:00Z"), { start: "12:00", end: "14:00", timeZone: "UTC" })).toBe(true);
    expect(inQuietHours(new Date("2026-10-16T14:00:00Z"), { start: "12:00", end: "14:00", timeZone: "UTC" })).toBe(false);
    expect(inQuietHours(new Date(), null)).toBe(false);
    expect(inQuietHours(new Date(), { start: "25:00", end: "07:00", timeZone: "UTC" })).toBe(false);
  });

  it("caps first, then quiet hours", () => {
    expect(effectiveLevel("page", { overCap: true, quiet: true })).toEqual({ level: "note", demotedBy: "cap" });
    expect(effectiveLevel("ask", { overCap: false, quiet: true })).toEqual({ level: "flag", demotedBy: "quiet hours" });
    expect(effectiveLevel("flag", { overCap: false, quiet: false })).toEqual({ level: "flag", demotedBy: null });
    expect(effectiveLevel("note", { overCap: true, quiet: true })).toEqual({ level: "note", demotedBy: null });
  });
});
