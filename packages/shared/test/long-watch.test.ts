import { describe, expect, it } from "vitest";
import { eventWatchPhrase, longWatchIndexes, longWatchPhrase, watchPhrase, type Criterion } from "../src/acceptance.js";

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

// BOS-2797: an after-merge criterion that waits on a future event (not a length of time) is split the same way. The
// hits are the hand-split tickets' own words (BOS-2663, BOS-974, BOS-2778, BOS-2779); the misses are one-time readings.
describe("eventWatchPhrase", () => {
  it.each([
    ["After the next beta release, a real image install shows the new-release note within a day", "the next beta release"],
    ["One real install from published images on x86 and ARM", "One real install"],
    ["On the next real update the card closes by itself", "the next real update"],
    ["On the next real runner update, no agent run is killed", "the next real runner update"],
    ["The next weekly release lists the change", "The next weekly release"],
    ["After the next release the website shows the new words", "the next release"],
    ["A real image install shows the note", "A real image install"],
    ["The first real stuck alert wakes the CEO", "The first real stuck"],
    ["The push arrives on the owner's phone", "on the owner's phone"],
    ["Works on the owner's own device in Safari", "on the owner's own device"],
  ])("matches %j", (text, phrase) => {
    expect(eventWatchPhrase(text)).toBe(phrase);
    expect(watchPhrase(text)).toBe(phrase);
  });

  it.each([
    "The live page shows the new line",
    "The live What's new page shows the entry",
    "One go-live reading of /api/health shows ok",
    "On the owner's host, Settings → Updates shows the commit",
    "Settings → Updates shows the next release date",
    "The next release notes list the fix",
    "A real-looking error is shown in the log",
    "The release workflow runs on a real tag",
  ])("leaves %j alone", (text) => {
    expect(eventWatchPhrase(text)).toBeNull();
    expect(watchPhrase(text)).toBeNull();
  });

  it("prefers the duration when a criterion has both", () => {
    expect(watchPhrase("For 3 days after the next release no run fails")).toBe("For 3 days after");
  });
});

describe("longWatchIndexes", () => {
  it("lists after-merge criteria that wait on an event, and never a criterion checked in review", () => {
    const criteria: Criterion[] = [
      "After the next beta release the note shows", // checked in review: never split
      { text: "The live page shows the new line", after: "merge" },
      { text: "One real install from published images works", after: "merge" },
      { text: "On the next real server update the card closes", after: "merge" },
    ];
    expect(longWatchIndexes(criteria)).toEqual([2, 3]);
  });

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
