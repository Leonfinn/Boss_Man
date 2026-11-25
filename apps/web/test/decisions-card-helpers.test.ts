// BOS-1445 (Background lane): the pure helpers behind a decision card that had no direct test:
// the ticket its attachments belong to, the failed-send wording, which recommendation the card shows
// once the CEO has advised, and the card id in a #/decisions/<id> link.
import { describe, expect, it } from "vitest";
import type { Decision } from "../src/api";
import { cardTicketId, effectiveRecommendation, kindKeyOf, linkedCardOf, sendFailed, waitedMinutes } from "../src/pages/Decisions";

const ticket = (id: string) => ({ ticketId: id, ref: `APP-${id}`, title: `Ticket ${id}` });

const card = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "permission",
  question: "Let Moss run a command?",
  options: ["Allow once", "Deny"],
  recommendedOption: "Allow once",
  tier: "owner",
  createdAt: "2026-11-10T09:30:00.000Z",
  companyName: "App Co",
  agentName: "Moss",
  blocks: [],
  about: [],
  score: 0,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  ...over,
});

describe("cardTicketId", () => {
  it("uses the ticket the card blocks first", () => {
    expect(cardTicketId(card({ blocks: [ticket("t1")], about: [ticket("t2")] }))).toBe("t1");
  });

  it("falls back to the first ticket the card is about when it blocks none", () => {
    expect(cardTicketId(card({ blocks: [], about: [ticket("t2"), ticket("t3")] }))).toBe("t2");
  });

  it("has no ticket when the card blocks and is about nothing", () => {
    expect(cardTicketId(card({ blocks: [], about: [] }))).toBeUndefined();
    expect(cardTicketId(card({ blocks: [], about: undefined }))).toBeUndefined();
  });
});

describe("sendFailed", () => {
  it("says what failed and that the note is kept", () => {
    expect(sendFailed(new Error("the server is unreachable"))).toBe("Couldn't send your answer: the server is unreachable. Your note is kept; try again.");
  });

  it("drops a trailing full stop and trailing spaces so the sentence has one stop", () => {
    expect(sendFailed(new Error("Timed out."))).toBe("Couldn't send your answer: Timed out. Your note is kept; try again.");
    expect(sendFailed(new Error("Network down.  "))).toBe("Couldn't send your answer: Network down. Your note is kept; try again.");
  });

  it("keeps a message that ends in another mark", () => {
    expect(sendFailed(new Error("Is the server up?"))).toBe("Couldn't send your answer: Is the server up?. Your note is kept; try again.");
  });

  it("still says the note is kept for an empty message", () => {
    expect(sendFailed(new Error(""))).toBe("Couldn't send your answer: . Your note is kept; try again.");
  });
});

describe("effectiveRecommendation", () => {
  it("leaves a non-permission card on the rule's recommendation", () => {
    expect(effectiveRecommendation(card({ kind: "approval", options: ["Approve", "Reject"], recommendedOption: "Approve", context: { advice: { state: "advised", recommendation: "deny" } } }))).toEqual({ option: "Approve", rule: null });
  });

  it("leaves the rule's recommendation while the CEO's advice is not settled", () => {
    expect(effectiveRecommendation(card({ context: { advice: { state: "asking" } } }))).toEqual({ option: "Allow once", rule: null });
    expect(effectiveRecommendation(card({ context: {} }))).toEqual({ option: "Allow once", rule: null });
    expect(effectiveRecommendation(card({ context: { advice: { state: "advised" } } }))).toEqual({ option: "Allow once", rule: null });
  });

  it("shows the CEO's Allow as the recommendation and the rule's answer as the rule's own", () => {
    expect(effectiveRecommendation(card({ options: ["Allow once", "Deny"], recommendedOption: "Deny", context: { advice: { state: "advised", recommendation: "allow" } } }))).toEqual({ option: "Allow once", rule: "Deny" });
  });

  it("shows the CEO's Deny as the recommendation and the rule's Allow as the rule's own", () => {
    expect(effectiveRecommendation(card({ options: ["Allow once", "Deny"], recommendedOption: "Allow once", context: { advice: { state: "advised", recommendation: "deny" } } }))).toEqual({ option: "Deny", rule: "Allow once" });
  });

  it("adds no rule line when the CEO and the rule agree", () => {
    expect(effectiveRecommendation(card({ options: ["Allow once", "Deny"], recommendedOption: "Allow once", context: { advice: { state: "advised", recommendation: "allow" } } }))).toEqual({ option: "Allow once", rule: null });
  });

  it("finds the option whatever its case", () => {
    expect(effectiveRecommendation(card({ options: ["ALLOW ONCE", "Deny"], recommendedOption: "Deny", context: { advice: { state: "advised", recommendation: "allow" } } }))).toEqual({ option: "ALLOW ONCE", rule: "Deny" });
  });

  it("falls back to the rule when the card has no matching option for the CEO's advice", () => {
    expect(effectiveRecommendation(card({ options: ["Approve", "Reject"], recommendedOption: "Approve", context: { advice: { state: "advised", recommendation: "deny" } } }))).toEqual({ option: "Approve", rule: null });
  });
});

describe("kindKeyOf", () => {
  const key = (kind: string, options: string[] = [], type?: string) =>
    kindKeyOf({ kind, options, ...(type ? { context: { type } } : {}) });

  it("keeps a deploy, a self-deploy and a rule proposal as themselves", () => {
    expect(key("approval", ["Approve", "Reject"], "deploy")).toBe("deploy");
    expect(key("approval", ["Approve", "Reject"], "self_deploy")).toBe("self_deploy");
    expect(key("rule_proposal", ["Add it", "Skip"], "rule_proposal")).toBe("rule_proposal");
  });

  it("reads a card that offers Approve plan as a plan", () => {
    expect(key("approval", ["Approve plan", "Keep planning"])).toBe("plan");
  });

  it("reads a risk review as a signoff and a review stall as itself", () => {
    expect(key("question", [], "risk_review")).toBe("signoff");
    expect(key("question", [], "review_stall")).toBe("review_stall");
  });

  it("otherwise falls back to the card's own kind", () => {
    expect(key("permission", ["Allow once", "Deny"])).toBe("permission");
    expect(key("question", [], "something_else")).toBe("question");
    expect(key("hire")).toBe("hire");
  });

  it("puts a deploy context ahead of an Approve plan option", () => {
    expect(key("approval", ["Approve plan", "Keep planning"], "deploy")).toBe("deploy");
  });
});

describe("waitedMinutes", () => {
  type Item = Parameters<typeof waitedMinutes>[0];
  const answered = (over: Partial<Item> = {}): Item => ({
    id: "a1",
    question: "Run the backup?",
    status: "answered",
    answer: "Yes",
    by: "owner",
    byName: null,
    at: "2026-11-10T11:00:00.000Z",
    askedAt: "2026-11-10T09:30:00.000Z",
    ticket: null,
    ...over,
  });

  it("counts whole minutes between asked and answered", () => {
    expect(waitedMinutes(answered())).toBe(90);
  });

  it("rounds a part minute to the nearest whole minute", () => {
    expect(waitedMinutes(answered({ at: "2026-11-10T09:31:29.000Z" }))).toBe(1);
    expect(waitedMinutes(answered({ at: "2026-11-10T09:31:31.000Z" }))).toBe(2);
  });

  it("never goes below zero when the answer came before the question", () => {
    expect(waitedMinutes(answered({ at: "2026-11-10T09:00:00.000Z" }))).toBe(0);
  });

  it("has no wait for a withdrawn card or one with no asked time", () => {
    expect(waitedMinutes(answered({ status: "withdrawn" }))).toBeNull();
    expect(waitedMinutes(answered({ askedAt: undefined }))).toBeNull();
  });

  it("has no wait when a date cannot be read", () => {
    expect(waitedMinutes(answered({ askedAt: "not a date" }))).toBeNull();
    expect(waitedMinutes(answered({ at: "not a date" }))).toBeNull();
  });
});

describe("linkedCardOf", () => {
  const ID = "123e4567-e89b-12d3-a456-426614174000";

  it("reads the card id from a decisions link", () => {
    expect(linkedCardOf(`#/decisions/${ID}`)).toBe(ID);
  });

  it("accepts the link without the slash after the hash", () => {
    expect(linkedCardOf(`#decisions/${ID}`)).toBe(ID);
  });

  it("accepts an uppercase id", () => {
    const upper = "123E4567-E89B-12D3-A456-426614174000";
    expect(linkedCardOf(`#/decisions/${upper}`)).toBe(upper);
  });

  it("ignores anything after the id", () => {
    expect(linkedCardOf(`#/decisions/${ID}/note`)).toBe(ID);
  });

  it("is null for another page", () => {
    expect(linkedCardOf(`#/tickets/${ID}`)).toBeNull();
  });

  it("is null when the id is not a card id", () => {
    expect(linkedCardOf("#/decisions/not-a-card")).toBeNull();
    expect(linkedCardOf("#/decisions")).toBeNull();
  });

  it("is null for an empty link", () => {
    expect(linkedCardOf("")).toBeNull();
  });
});
