// BOS-2650 (background lane): the pure wording helpers around long after-merge watches, the holder of a wake, and
// GitHub's refusal to cancel a run. Every value here is made up; nothing opens a database, reads the clock or calls out.
import { describe, expect, it } from "vitest";
import { longWatchNote, type LongWatchCheck } from "../src/services/after-merge-check-tickets.js";
import { HOLD_REASON, holdReasonFor, runnerCardHold, WRAPUP_HOLD_REASON, type Hold } from "../src/services/maintenance.js";
import { cancelRefusal } from "../src/services/git-hosts.js";
import { describeNote } from "../src/services/agent-notes.js";

const watch = (criterion: number, phrase: string, ref: string, id: string): LongWatchCheck => ({ criterion, phrase, ref, id });

describe("longWatchNote", () => {
  it("says nothing when no criterion needs a long watch", () => {
    expect(longWatchNote([])).toBe("");
  });

  it("names the criterion, its phrase, the check ticket's ref and its id, starting with a space", () => {
    const note = longWatchNote([watch(2, "a week on", "BOS-2651", "chk_a1b2c3")]);
    expect(note.startsWith(" ")).toBe(true);
    expect(note).toContain("Criterion 2");
    expect(note).toContain('"a week on"');
    expect(note).toContain("BOS-2651");
    expect(note).toContain("chk_a1b2c3");
  });

  it("gives both checks, in order, when two criteria need a watch", () => {
    const note = longWatchNote([
      watch(2, "a week on", "BOS-2651", "chk_a1b2c3"),
      watch(3, "over 3 days live", "BOS-2652", "chk_d4e5f6"),
    ]);
    expect(note.startsWith(" ")).toBe(true);
    expect(note.indexOf("Criterion 2")).toBeLessThan(note.indexOf("Criterion 3"));
    expect(note).toContain('"a week on"');
    expect(note).toContain('"over 3 days live"');
    expect(note).toContain("BOS-2651");
    expect(note).toContain("BOS-2652");
    expect(note).toContain("chk_a1b2c3");
    expect(note).toContain("chk_d4e5f6");
  });
});

describe("holdReasonFor", () => {
  it("uses the constants' own words", () => {
    expect(HOLD_REASON).toBe("update pending");
    expect(WRAPUP_HOLD_REASON).toBe("wrap-up pending");
    expect(WRAPUP_HOLD_REASON).not.toBe(HOLD_REASON);
  });

  it("names a wrap-up hold as a wrap-up", () => {
    expect(holdReasonFor({ kind: "wrapup" })).toBe(WRAPUP_HOLD_REASON);
  });

  it("treats an update, a setting change, a build and an old hold with no kind as an update", () => {
    expect(holdReasonFor({ kind: "update" })).toBe(HOLD_REASON);
    expect(holdReasonFor({ kind: "settings" })).toBe(HOLD_REASON);
    expect(holdReasonFor({ kind: "building" })).toBe(HOLD_REASON);
    expect(holdReasonFor({})).toBe(HOLD_REASON);
  });
});

describe("runnerCardHold", () => {
  const hold = (kind: Hold["kind"]): Hold => ({ reason: "made-up", kind, since: "2026-11-26T09:00:00.000Z", deadline: "2026-11-26T09:10:00.000Z", minutes: 10 });

  it("has no card for no hold", () => {
    expect(runnerCardHold(null)).toBeNull();
  });

  it("has no card for a wrap-up hold", () => {
    expect(runnerCardHold(hold("wrapup"))).toBeNull();
  });

  it("gives the same hold back for an update", () => {
    const update = hold("update");
    expect(runnerCardHold(update)).toBe(update);
  });
});

describe("cancelRefusal", () => {
  it("blames the token's missing permission for a 401 or 403, and shows the status", () => {
    for (const status of [401, 403]) {
      const said = cancelRefusal(status, "Bad credentials");
      expect(said).toContain("can't cancel GitHub runs");
      expect(said).toContain(`GitHub answered ${status}`);
    }
  });

  it("reads GitHub's 422 'Resource not accessible by integration' as the same permission problem", () => {
    const said = cancelRefusal(422, "Resource not accessible by integration");
    expect(said).toContain("can't cancel GitHub runs");
    expect(said).toContain("GitHub answered 422");
  });

  it("words any other status as a plain refusal, with the HTTP status and GitHub's message", () => {
    expect(cancelRefusal(500, "server exploded")).toBe("GitHub refused to cancel the run (HTTP 500: server exploded)");
  });

  it("says there was no answer for status 0", () => {
    expect(cancelRefusal(0, "socket hang up")).toBe("GitHub refused to cancel the run (no answer: socket hang up)");
  });

  it("puts a message with line breaks and runs of spaces on one line", () => {
    expect(cancelRefusal(500, "first line\nsecond   line\tthird")).toBe("GitHub refused to cancel the run (HTTP 500: first line second line third)");
  });

  it("cuts a long message to 200 characters", () => {
    expect(cancelRefusal(500, "z".repeat(300))).toBe(`GitHub refused to cancel the run (HTTP 500: ${"z".repeat(200)})`);
  });
});

describe("describeNote", () => {
  it("shows the note's title, text and why", () => {
    expect(describeNote({ title: "Keep replies short", text: "One or two sentences.", why: "The owner asked for it." })).toBe(
      '"Keep replies short": One or two sentences. (why: "The owner asked for it.")',
    );
  });
});
