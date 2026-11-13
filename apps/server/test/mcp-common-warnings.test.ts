// The plain-words heads-ups create_ticket adds: a code ticket that will be hard to pick up (BOS-595),
// and a live-looking criterion that isn't marked after merge (BOS-575). These are pure functions, so
// no server or database is built here (BOS-663).
import { describe, expect, it } from "vitest";
import { criteriaWarning, thinTicketWarning } from "../src/mcp-common.js";

describe("thinTicketWarning", () => {
  it("says nothing when the ticket has both a description and an assignee", () => {
    expect(thinTicketWarning("Do the thing.", "Dev")).toBe("");
  });

  it("names the missing description when the body is missing, empty or only whitespace", () => {
    for (const body of [undefined, null, "", "   \n\t "]) {
      const warning = thinTicketWarning(body, "Dev");
      expect(warning).toContain("no description");
      expect(warning).not.toContain("no assignee");
    }
  });

  it("names the missing assignee when there is a description but nobody to take it", () => {
    for (const assignee of [undefined, ""]) {
      const warning = thinTicketWarning("Do the thing.", assignee);
      expect(warning).toContain("no assignee");
      expect(warning).not.toContain("no description");
    }
  });

  it("names both gaps, joined with 'and', when neither is set", () => {
    const warning = thinTicketWarning(undefined, undefined);
    expect(warning).toMatch(/no description.*and.*no assignee/);
  });

  it("starts with a blank line so it reads as its own paragraph in the reply", () => {
    expect(thinTicketWarning("Do the thing.", undefined)).toMatch(/^\n\n/);
    expect(thinTicketWarning(undefined, "Dev")).toMatch(/^\n\n/);
    expect(thinTicketWarning(undefined, undefined)).toMatch(/^\n\n/);
  });
});

describe("criteriaWarning", () => {
  it("says nothing when there are no criteria", () => {
    expect(criteriaWarning(undefined)).toBe("");
    expect(criteriaWarning([])).toBe("");
  });

  it("warns, as its own paragraph, about a criterion that can only be checked once live", () => {
    const warning = criteriaWarning(["The owner confirms it on a real host"]);
    expect(warning).toMatch(/^\n\nHeads-up: /);
    expect(warning).toContain("on a real host");
  });

  it("says nothing when that same criterion is marked after merge", () => {
    expect(criteriaWarning([{ text: "The owner confirms it on a real host", after: "merge" }])).toBe("");
  });
});
