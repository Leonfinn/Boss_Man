import { describe, expect, it } from "vitest";
import { longWatchIndexes, longWatchPhrase, type Criterion } from "../src/acceptance.js";

// BOS-2643: an after-merge criterion that needs a day or more of live use is opened as its own check ticket, so the
// build can close at go-live. The match is a small fixed set: a duration with watch wording around it. A one-time
// reading stays on the build ticket, so the misses here matter as much as the hits.

describe("longWatchPhrase", () => {
  it.each([
    ["Over 3 days live, no main CI or Publish images run is cancelled", "Over 3 days live"],
    ["A week after go-live, no CEO permission card has a command that sets its own shell variable", "A week after"],
    ["No new stuck alerts a week on", "a week on"],
    ["The queue stays under 5 jobs for 48 hours", "for 48 hours"],
    ["7 days of runs show no timeout", "7 days of"],
    ["after 2 weeks the cache hit rate is above 90%", "after 2 weeks"],
    ["a 3-day watch of the nightly runs shows no failure", "3-day watch"],
    ["Across the next two weeks no runner restarts", "Across the next two weeks"],
    ["No alert in the first 24 hours", "in the first 24 hours"],
    ["for a day nothing is cancelled", "for a day"],
  ])("matches %j", (text, phrase) => {
    expect(longWatchPhrase(text)).toBe(phrase);
  });

  it.each([
    "The merge lands within 2 days",
    "No error for 12 hours after the switch",
    "One go-live reading of /api/health shows ok",
    "The owner looks once at Settings → Updates",
    "Runs every Monday at 09:00",
    "Logs older than 30 days are deleted",
    "3 days",
    "0 days of downtime",
  ])("leaves %j alone", (text) => {
    expect(longWatchPhrase(text)).toBeNull();
  });
});

describe("longWatchIndexes", () => {
  it("lists only after-merge criteria with a long watch, by position", () => {
    const criteria: Criterion[] = [
      "Over 3 days live nothing breaks", // checked in review: never split, whatever it says
      { text: "One go-live reading shows the new line", after: "merge" },
      { text: "A week on, no new stuck alerts", after: "merge" },
    ];
    expect(longWatchIndexes(criteria)).toEqual([2]);
  });

  it("is empty with no criteria", () => {
    expect(longWatchIndexes([])).toEqual([]);
  });
});
