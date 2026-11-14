// BOS-1353: the two checks that say when waiting work may go. Both are reached through the database
// in other tests; these pin their edges directly, with no database.
import { describe, expect, it } from "vitest";
import { ticketBlockerFinished } from "../src/services/ticket-links.js";
import { holdReady } from "../src/services/review-holds.js";

const SHA = "a".repeat(40);

describe("ticketBlockerFinished", () => {
  it("is finished when the blocker is done, for a link waiting until done or until merged, with or without a merge commit", () => {
    expect(ticketBlockerFinished({ ticketState: "done", mergeCommit: null, until: "done" })).toBe(true);
    expect(ticketBlockerFinished({ ticketState: "done", mergeCommit: SHA, until: "done" })).toBe(true);
    expect(ticketBlockerFinished({ ticketState: "done", mergeCommit: null, until: "merged" })).toBe(true);
    expect(ticketBlockerFinished({ ticketState: "done", mergeCommit: SHA, until: "merged" })).toBe(true);
  });

  it("is finished for a link waiting until merged once the blocker's merge commit is on main, even in review", () => {
    expect(ticketBlockerFinished({ ticketState: "review", mergeCommit: SHA, until: "merged" })).toBe(true);
  });

  it("is not finished for a link waiting until merged while the blocker has no merge commit", () => {
    expect(ticketBlockerFinished({ ticketState: "review", mergeCommit: null, until: "merged" })).toBe(false);
    expect(ticketBlockerFinished({ ticketState: "review", mergeCommit: "", until: "merged" })).toBe(false);
  });

  it("is not finished for a link waiting until done just because the blocker has a merge commit", () => {
    expect(ticketBlockerFinished({ ticketState: "review", mergeCommit: SHA, until: "done" })).toBe(false);
  });

  it("is not finished when the blocker's state is unknown and it has no merge commit", () => {
    expect(ticketBlockerFinished({ ticketState: null, mergeCommit: null, until: "merged" })).toBe(false);
    expect(ticketBlockerFinished({ ticketState: null, mergeCommit: null, until: "done" })).toBe(false);
  });
});

describe("holdReady", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const past = new Date(now.getTime() - 1_000);
  const future = new Date(now.getTime() + 1_000);

  it("is not ready with no waits and no release date", () => {
    expect(holdReady({ releaseAt: null }, [], now)).toBe(false);
  });

  it("is ready with no waits once the release date is in the past", () => {
    expect(holdReady({ releaseAt: past }, [], now)).toBe(true);
  });

  it("is ready with no waits when the release date is exactly now", () => {
    expect(holdReady({ releaseAt: new Date(now.getTime()) }, [], now)).toBe(true);
  });

  it("is not ready with no waits when the release date is one second ahead", () => {
    expect(holdReady({ releaseAt: future }, [], now)).toBe(false);
  });

  it("is ready with no release date once every wait has closed", () => {
    expect(holdReady({ releaseAt: null }, [{ closed: true }, { closed: true }], now)).toBe(true);
  });

  it("is not ready with no release date while one wait is still open", () => {
    expect(holdReady({ releaseAt: null }, [{ closed: true }, { closed: false }], now)).toBe(false);
  });

  it("is ready when the release date has come even though a wait is still open", () => {
    expect(holdReady({ releaseAt: past }, [{ closed: false }], now)).toBe(true);
  });
});
