// BOS-2413 (background lane): the CEO's note for a merge-line holder sent back by the gate, without a database.
import { describe, expect, it } from "vitest";
import { lineHolderNote, type LineHolder } from "../src/services/line-holder.js";

const holder = (over: Partial<LineHolder> = {}): LineHolder => ({
  why: "fixes_merge_check",
  waiting: 2,
  attempt: 3,
  ref: "BOS-42",
  title: "Fix the failing check",
  ...over,
});

describe("lineHolderNote", () => {
  it("names the ticket, the assignee, the attempt and the send-back, and says how many wait on it", () => {
    const note = lineHolderNote(holder(), "the check failed", "Basil");
    expect(note).toContain('BOS-42 "Fix the failing check"');
    expect(note).toContain("sent BOS-42 \"Fix the failing check\" back to Basil on merge attempt 3: the check failed.");
    expect(note).toContain("it's marked as fixing the merge check; 2 tickets wait on it");
    expect(note).toContain("make sure Basil is on it");
  });

  it("says 'no ticket waits on it yet' and falls back to 'its assignee' / 'someone' when nothing is known", () => {
    const note = lineHolderNote(holder({ why: "main_ci", waiting: 0, attempt: 1 }), "the tests broke", null);
    expect(note).toContain("sent BOS-42 \"Fix the failing check\" back to its assignee on merge attempt 1: the tests broke.");
    expect(note).toContain("it's the fix for main's failing CI; no ticket waits on it yet");
    expect(note).toContain("make sure someone is on it");
  });

  it("uses the singular for one waiting ticket and drops the reference when the ticket has none", () => {
    const one = lineHolderNote(holder({ waiting: 1, ref: null }), "the check failed", "Basil");
    expect(one).toContain('sent "Fix the failing check" back');
    expect(one).toContain("1 ticket waits on it");
    expect(one).not.toContain("BOS-42");
  });
});
