import { describe, expect, it } from "vitest";
import { actingText, ciWaitText, clockText, freeSlotsText, rowState } from "../src/pages/MergeQueue";

// BOS-1846: the sentences the owner reads on the Merge queue page, pinned with a fixed clock. Clock times are built
// from the reader's own locale in the test, so the pin holds on any runner's time zone and language.

const NOW = new Date(2026, 10, 19, 12, 0, 0); // local 19 Nov 2026, 12:00
const hhmm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

describe("ciWaitText", () => {
  it("names the jobs still waiting", () => {
    expect(ciWaitText({ minutes: 12, waiting: ["images (arm64)", "check"] })).toBe("Waiting for GitHub CI: images (arm64), check, 12 min so far. It merges only once CI passes.");
  });
  it("names one job", () => {
    expect(ciWaitText({ minutes: 1, waiting: ["check"] })).toBe("Waiting for GitHub CI: check, 1 min so far. It merges only once CI passes.");
  });
  it("leaves out the colon when no job is named", () => {
    expect(ciWaitText({ minutes: 0, waiting: [] })).toBe("Waiting for GitHub CI, 0 min so far. It merges only once CI passes.");
  });
  it("never shows negative minutes", () => {
    expect(ciWaitText({ minutes: -3, waiting: [] })).toContain(", 0 min so far");
  });
});

describe("clockText", () => {
  it("shows only the time for today", () => {
    const t = new Date(2026, 10, 19, 9, 5);
    expect(clockText(t.toISOString(), NOW)).toBe(hhmm(t));
  });
  it("adds the date for another day, in the past or the future", () => {
    const past = new Date(2026, 10, 9, 12, 55);
    const future = new Date(2026, 10, 20, 8, 30);
    for (const d of [past, future]) {
      const out = clockText(d.toISOString(), NOW);
      expect(out).toBe(`${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${hhmm(d)}`);
      expect(out).toContain(", ");
    }
  });
  it("treats just before midnight as the same day only when the date matches", () => {
    const lateLastNight = new Date(2026, 10, 18, 23, 59);
    expect(clockText(lateLastNight.toISOString(), NOW)).not.toBe(hhmm(lateLastNight));
  });
});

describe("freeSlotsText", () => {
  it("one slot", () => {
    expect(freeSlotsText(1, 1)).toBe("The slot is free.");
    expect(freeSlotsText(0, 1)).toBe("The slot is busy.");
  });
  it("two slots", () => {
    expect(freeSlotsText(2, 2)).toBe("Both slots are free.");
    expect(freeSlotsText(1, 2)).toBe("1 of 2 slots are free.");
    expect(freeSlotsText(0, 2)).toBe("No slot is free.");
  });
  it("many slots", () => {
    expect(freeSlotsText(4, 4)).toBe("All 4 slots are free.");
    expect(freeSlotsText(3, 4)).toBe("3 of 4 slots are free.");
    expect(freeSlotsText(0, 4)).toBe("No slot is free.");
  });
  it("more free than slots still reads as all free", () => {
    expect(freeSlotsText(5, 3)).toBe("All 3 slots are free.");
  });
});

describe("actingText", () => {
  it("speaks to the owner directly and names everyone else", () => {
    expect(actingText("owner")).toBe("you're acting");
    expect(actingText("ceo")).toBe("the CEO is acting");
    expect(actingText("agent")).toBe("the agent is acting");
    expect(actingText("system")).toBe("Boss Man is acting");
  });
});

describe("rowState", () => {
  const row = (over: Record<string, unknown> = {}) => ({ actor: null, state: "waiting_for_check_slot", stuck: false, ...over }) as unknown as Parameters<typeof rowState>[0];
  it("needs you when the owner is the actor, even if stuck or failed", () => {
    expect(rowState(row({ actor: "owner", stuck: true, state: "check_failed_retrying" }))).toEqual({ word: "Needs you", tone: "amber" });
  });
  it("check failed beats stuck", () => {
    expect(rowState(row({ state: "check_failed_retrying", stuck: true }))).toEqual({ word: "Check failed", tone: "red" });
  });
  it("stuck beats checking", () => {
    expect(rowState(row({ stuck: true, state: "checking" }))).toEqual({ word: "Stuck", tone: "red" });
  });
  it("checking is blue", () => {
    expect(rowState(row({ state: "checking" }))).toEqual({ word: "Checking", tone: "blue" });
  });
  it("every kind of hold reads Held", () => {
    for (const state of ["held", "waiting_host", "waiting_for_other_ticket", "waiting_for_decision"]) expect(rowState(row({ state }))).toEqual({ word: "Held", tone: "grey" });
  });
  it("anything else reads Waiting", () => {
    expect(rowState(row({ actor: "ceo" }))).toEqual({ word: "Waiting", tone: "grey" });
  });
});
