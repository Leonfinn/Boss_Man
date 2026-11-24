// BOS-2137 (background lane): the two labels the merge queue shows for a waiting landing and a carried-work hold.
// Both are pure and take their input as arguments (no clock, no database), so made-up values pin the exact words.
import { describe, expect, it } from "vitest";
import { CARRIED_NOTE_PREFIX, carriedHold, ciWaitLabel, turnWaitLabel } from "../src/services/merge-queue.js";

describe("ciWaitLabel (BOS-2137)", () => {
  it("names no job when GitHub has not reported one yet", () => {
    expect(ciWaitLabel({ minutes: 0, waiting: [] })).toBe("waiting for GitHub CI on its merge copy, 0 min so far");
    expect(ciWaitLabel({ minutes: 12, waiting: [] })).toBe("waiting for GitHub CI on its merge copy, 12 min so far");
  });

  it("names the jobs GitHub is still running, in the order it was given them", () => {
    expect(ciWaitLabel({ minutes: 3, waiting: ["check"] })).toBe(
      "waiting for GitHub CI on its merge copy (check), 3 min so far",
    );
    expect(ciWaitLabel({ minutes: 3, waiting: ["check", "web"] })).toBe(
      "waiting for GitHub CI on its merge copy (check, web), 3 min so far",
    );
  });

  it("writes minutes under an hour and hours and minutes after", () => {
    expect(ciWaitLabel({ minutes: 59, waiting: [] })).toBe("waiting for GitHub CI on its merge copy, 59 min so far");
    expect(ciWaitLabel({ minutes: 60, waiting: [] })).toBe("waiting for GitHub CI on its merge copy, 1 h so far");
    expect(ciWaitLabel({ minutes: 70, waiting: [] })).toBe("waiting for GitHub CI on its merge copy, 1 h 10 min so far");
    expect(ciWaitLabel({ minutes: 125, waiting: [] })).toBe("waiting for GitHub CI on its merge copy, 2 h 5 min so far");
  });

  it("never shows a negative wait", () => {
    expect(ciWaitLabel({ minutes: -3, waiting: [] })).toBe("waiting for GitHub CI on its merge copy, 0 min so far");
  });
});

describe("carriedHold (BOS-2137)", () => {
  const sentence = `${CARRIED_NOTE_PREFIX} unapproved work from Fix the login (low risk), which must merge first.`;

  it("is not held for a missing or unrelated note", () => {
    expect(carriedHold(null)).toEqual({ titles: [], note: null });
    expect(carriedHold(undefined)).toEqual({ titles: [], note: null });
    expect(carriedHold("")).toEqual({ titles: [], note: null });
    expect(carriedHold('Some other hold naming "Fix the login"')).toEqual({ titles: [], note: null });
  });

  it("reads the titles from the hidden JSON line and keeps only the owner's sentence", () => {
    const note = `${sentence}\n${JSON.stringify(["Fix the login", "Add tests"])}`;
    expect(carriedHold(note)).toEqual({ titles: ["Fix the login", "Add tests"], note: sentence });
  });

  it("keeps a title with quotes or an apostrophe whole (BOS-819)", () => {
    const titles = ['Fix the "quoted" thing', "Owner's own words"];
    const note = `${sentence}\n${JSON.stringify(titles)}`;
    expect(carriedHold(note)).toEqual({ titles, note: sentence });
  });

  it("reads an older note's quoted titles and returns it whole", () => {
    const old = `${CARRIED_NOTE_PREFIX} unapproved work from "Fix the login" and "Add tests" (low risk), which must merge first.`;
    expect(carriedHold(old)).toEqual({ titles: ["Fix the login", "Add tests"], note: old });
  });

  it("treats a last line that is not a JSON string list as the older form", () => {
    const notTitles = `${sentence}\n[1, 2]`;
    expect(carriedHold(notTitles)).toEqual({ titles: [], note: notTitles });
    const broken = `${sentence}\nnot json`;
    expect(carriedHold(broken)).toEqual({ titles: [], note: broken });
  });

  it("reads an empty title list as a held note with no titles", () => {
    const note = `${sentence}\n[]`;
    expect(carriedHold(note)).toEqual({ titles: [], note: sentence });
  });
});

describe("turnWaitLabel (BOS-2365)", () => {
  it("says a rebuild wait re-checks once the holder lands", () => {
    expect(turnWaitLabel("BOS-12", "rebuild")).toBe("waiting for BOS-12 to land, then re-checks");
  });

  it("says a push wait passed its check and only the push waits", () => {
    expect(turnWaitLabel("BOS-12", "push")).toBe("check passed; waiting for BOS-12 to land, then pushes");
  });

  it("puts the holder in verbatim, including a quoted title or no holder at all", () => {
    expect(turnWaitLabel('"Fix the login"', "rebuild")).toBe('waiting for "Fix the login" to land, then re-checks');
    expect(turnWaitLabel("another ticket", "push")).toBe("check passed; waiting for another ticket to land, then pushes");
    expect(turnWaitLabel("", "rebuild")).toBe("waiting for  to land, then re-checks");
  });

  it("gives different words for the two waits", () => {
    expect(turnWaitLabel("BOS-12", "rebuild")).not.toBe(turnWaitLabel("BOS-12", "push"));
  });
});
