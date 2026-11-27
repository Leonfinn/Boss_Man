// BOS-2771: the opening paragraph of an update card raised under a failed-update hold (holdCardLead), and the
// stamp that says which hold a card was raised under (holdStamp). Pure calls only: OwnerHold objects are built by
// hand, with fixed dates and made-up shas, no database.
import { describe, expect, it } from "vitest";
import { holdCardLead, holdStamp, type OwnerHold } from "../src/services/owner-holds.js";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";

function hold(over: Partial<OwnerHold> = {}): OwnerHold {
  return {
    id: "6f1c2b3a-0000-4000-8000-000000000040",
    subject: "server_deploy",
    reason: "the deploy exited 1",
    commit: COMMIT,
    result: "failed",
    ticketId: null,
    decisionId: null,
    createdAt: new Date("2026-11-27T06:00:00.000Z"),
    releaseBy: new Date("2026-11-27T08:00:00.000Z"),
    releasedAt: null,
    releasedBy: null,
    outcome: null,
    ownerText: null,
    endedAt: null,
    wokenAt: null,
    chasedAt: null,
    ...over,
  };
}

const released = (outcome: OwnerHold["outcome"], over: Partial<OwnerHold> = {}) =>
  hold({ releasedAt: new Date("2026-11-27T07:00:00.000Z"), releasedBy: "Basil", outcome, ownerText: "the schema migration broke", ...over });

describe("holdCardLead: a hold still running", () => {
  it("opens with Held:, names who is diagnosing it, and recommends Not now", () => {
    const { lead, notNow } = holdCardLead(hold(), COMMIT, "Basil is looking into it.");
    expect(lead.startsWith("Held:")).toBe(true);
    expect(lead).toContain("Basil is looking into it.");
    expect(notNow).toBe(true);
  });

  it("starts with the failure, in lower case after Held:", () => {
    expect(holdCardLead(hold(), COMMIT, "who").lead).toContain("Held: the last server update");
  });
});

describe("holdCardLead: released as unknown (the hold timed out)", () => {
  it("says nobody has confirmed the cause, names who is on it, and recommends Not now", () => {
    const { lead, notNow } = holdCardLead(released("unknown", { releasedBy: "timeout" }), COMMIT, "Basil is looking into it.");
    expect(lead).toContain("Nobody has confirmed the cause");
    expect(lead).toContain("Basil is looking into it.");
    expect(notNow).toBe(true);
  });
});

describe("holdCardLead: released as do_not_retry", () => {
  it("says the failed commit should not be tried again, quotes the release, and recommends Not now", () => {
    const { lead, notNow } = holdCardLead(released("do_not_retry"), COMMIT, "who");
    expect(lead).toContain("should not be tried again");
    expect(lead).toContain("Basil: the schema migration broke");
    expect(notNow).toBe(true);
  });

  it("matches the failed commit without regard to letter case", () => {
    const upper = holdCardLead(released("do_not_retry", { commit: COMMIT.toUpperCase() }), COMMIT, "who");
    expect(upper.lead).toContain("should not be tried again");
    expect(upper.notNow).toBe(true);
    const lower = holdCardLead(released("do_not_retry", { commit: COMMIT.toLowerCase() }), COMMIT.toUpperCase(), "who");
    expect(lower.lead).toContain("should not be tried again");
    expect(lower.notNow).toBe(true);
  });

  it("says another commit's version won't be offered again, and does not recommend Not now", () => {
    const { lead, notNow } = holdCardLead(released("do_not_retry"), "fedcba9876543210fedcba9876543210fedcba98", "who");
    expect(lead).toContain("that version won't be offered again");
    expect(lead).toContain("Basil: the schema migration broke");
    expect(notNow).toBe(false);
  });
});

describe("holdCardLead: released as retry_safe", () => {
  it("says the releaser looked into it, quotes their words, and does not recommend Not now", () => {
    const { lead, notNow } = holdCardLead(released("retry_safe"), COMMIT, "who");
    expect(lead).toContain("Basil looked into it: the schema migration broke");
    expect(notNow).toBe(false);
  });
});

describe("holdCardLead: the failure's wording follows result and subject", () => {
  const leadFor = (over: Partial<OwnerHold>) => holdCardLead(hold(over), COMMIT, "who").lead;

  it("says was switched back for rolled_back", () => {
    expect(leadFor({ result: "rolled_back" })).toContain("was switched back");
  });

  it("says only half finished for partial", () => {
    expect(leadFor({ result: "partial" })).toContain("only half finished");
  });

  it("says failed otherwise", () => {
    const lead = leadFor({ result: "failed" });
    expect(lead).toContain("failed at");
    expect(lead).not.toContain("was switched back");
    expect(lead).not.toContain("only half finished");
    expect(leadFor({ result: "something else" })).toContain("failed at");
  });

  it("names a server update with the short commit", () => {
    expect(leadFor({ subject: "server_deploy" })).toContain("server update (to 12345678)");
  });

  it("names a runner update with the short commit it was built from", () => {
    expect(leadFor({ subject: "runner_update" })).toContain("runner update (built from 12345678)");
  });
});

describe("holdStamp", () => {
  it("is null when there is no hold", () => {
    expect(holdStamp(null)).toBeNull();
  });

  it("ends in :held for an unreleased hold", () => {
    expect(holdStamp(hold())).toBe("6f1c2b3a-0000-4000-8000-000000000040:held");
  });

  it("ends in the outcome once the hold is released", () => {
    expect(holdStamp(released("retry_safe"))).toBe("6f1c2b3a-0000-4000-8000-000000000040:retry_safe");
    expect(holdStamp(released("do_not_retry"))).toBe("6f1c2b3a-0000-4000-8000-000000000040:do_not_retry");
    expect(holdStamp(released("unknown"))).toBe("6f1c2b3a-0000-4000-8000-000000000040:unknown");
  });
});
