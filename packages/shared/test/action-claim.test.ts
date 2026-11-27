import { describe, expect, it } from "vitest";
import { actionClaim } from "../src/action-claim.js";

// BOS-2737 (R60): the one "someone is on it" line. Each case claims only what its facts show.
const at = (hhmm: string) => new Date(`2026-11-26T${hhmm}:00Z`);

describe("actionClaim", () => {
  it("an open alert with no run and no ticket: raised at HH:MM, nobody has picked it up yet", () => {
    expect(actionClaim({ who: "The CEO", raisedAt: at("15:30") })).toEqual({ kind: "alerted", text: "The CEO was alerted: raised at 15:30 UTC, nobody has picked it up yet." });
    expect(actionClaim({ who: "The Scrum Master", raisedAt: "2026-11-26T09:05:00.000Z" }).text).toBe("The Scrum Master was alerted: raised at 09:05 UTC, nobody has picked it up yet.");
  });

  it("an alert whose time is unknown still never claims anyone is acting", () => {
    expect(actionClaim({ who: "The CEO", raisedAt: true }).text).toBe("The CEO was alerted: raised, nobody has picked it up yet.");
  });

  it("nobody alerted says so", () => {
    expect(actionClaim({ who: "The CEO" })).toEqual({ kind: "none", text: "Nobody has picked it up yet: the CEO has not been alerted." });
  });

  it("a started run names who and when, and the ticket", () => {
    expect(actionClaim({ who: "The CEO", raisedAt: at("09:00"), ticket: { ref: "APP-19", agent: "Nova" }, run: { agent: "Nova", startedAt: at("09:05") } })).toEqual({ kind: "started", text: "Nova started work on it on APP-19 at 09:05 UTC." });
  });

  it("an assigned ticket with no run says no run has started, with the wake time", () => {
    expect(actionClaim({ who: "The CEO", ticket: { ref: "APP-19", agent: "Nova", wokenAt: at("09:05") } }).text).toBe("APP-19 is assigned to Nova, woken at 09:05 UTC; no run has started on it yet.");
    expect(actionClaim({ who: "The CEO", ticket: { ref: "APP-19", agent: "Nova" } }).text).toBe("APP-19 is assigned to Nova; no run has started on it yet.");
    // The alert to `who` is not the assignee's wake: its time is never shown as theirs.
    expect(actionClaim({ who: "The CEO", raisedAt: at("08:00"), ticket: { ref: "APP-19", agent: "Nova" } }).text).toBe("APP-19 is assigned to Nova; no run has started on it yet.");
  });

  it("kept text (live: false) names the ticket and assignee, never that work is under way", () => {
    const f = { who: "The CEO", ticket: { ref: "APP-19", agent: "Nova" }, run: { agent: "Nova", startedAt: at("09:05") }, live: false };
    expect(actionClaim(f)).toEqual({ kind: "assigned", text: "APP-19 is assigned to Nova." });
  });

  it("an unassigned ticket says so, and the alert time if there was one", () => {
    expect(actionClaim({ who: "The CEO", raisedAt: at("15:30"), ticket: { ref: "BOS-9", agent: null } }).text).toBe("BOS-9 is open for it, not assigned yet. The CEO was alerted: raised at 15:30 UTC, nobody has picked it up yet.");
  });

  it("an answered alert quotes the answer, cut at 200 characters", () => {
    expect(actionClaim({ who: "The CEO", raisedAt: at("15:30"), answered: { note: "Restarted the proxy." } }).text).toBe('The CEO answered the alert: "Restarted the proxy."');
    expect(actionClaim({ who: "The CEO", answered: { note: null } }).text).toBe("The CEO answered the alert.");
    expect(actionClaim({ who: "The CEO", answered: { note: "x".repeat(250) } }).text).toBe(`The CEO answered the alert: "${"x".repeat(200)}…"`);
  });
});
