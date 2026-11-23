// BOS-2359: the sentence the Merges tab shows for a landing turn, and the estimate on a ticket's status line.
import { describe, expect, it } from "vitest";
import { landingTurnText, statusLineText, type LandingTurn } from "../src/pages/MergeQueue";

const turn = (over: Partial<LandingTurn["holder"]> = {}, usualWaitMin: number | null = 23): LandingTurn => ({
  projectId: "p",
  holder: { ticketId: "t", ref: "BOS-2337", title: "Holder change", since: "2026-11-23T14:50:00Z", waitingFor: "GitHub run", waitingSince: "2026-11-23T14:52:00Z", landsAt: "2026-11-23T15:15:00Z", overdue: false, ...over },
  usualWaitMin,
  samples: 5,
  line: [],
});

describe("landingTurnText", () => {
  it("names the holder, what it waits for, the usual wait and when it should land", () => {
    const text = landingTurnText(turn());
    expect(text).toMatch(/^BOS-2337 holds the landing turn since .+, waiting for the GitHub run, started .+\./);
    expect(text).toContain("A landing usually waits about 23 min for GitHub.");
    expect(text).toMatch(/Expected to land about .+\.$/);
  });

  it("says so when the turn is well past the usual wait, and leaves out the estimate it doesn't have", () => {
    const text = landingTurnText(turn({ overdue: true, landsAt: null }, 23));
    expect(text).toContain("this one is well past that");
    expect(text).not.toContain("Expected to land");
    expect(landingTurnText(turn({}, null))).not.toContain("usually waits");
  });
});

describe("statusLineText with an estimate", () => {
  it("ends with the expected land time, only when there is one", () => {
    const base = { step: "waiting for the GitHub run", since: "2026-11-23T14:52:00Z", next: "", blocker: null };
    expect(statusLineText({ ...base, landsAt: "2026-11-23T15:15:00Z" })).toMatch(/ Expected to land about .+\.$/);
    expect(statusLineText(base)).not.toContain("Expected to land");
  });
});
