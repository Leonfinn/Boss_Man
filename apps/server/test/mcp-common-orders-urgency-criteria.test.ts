import { describe, expect, it } from "vitest";
import type { Criterion } from "@boss-man/shared";
import { criterionLines, fail, text, unlinkedOrderWarning, urgentClaims } from "../src/mcp-common.js";

describe("unlinkedOrderWarning: an ordering written as prose with no waits-on link", () => {
  it("warns about one ticket and says how to link it", () => {
    expect(unlinkedOrderWarning(["after BOS-12"], new Set())).toBe(
      '\n\nHeads-up: the text says this comes after BOS-12, but there is no waits-on link to it, so nothing waits and you will not be woken when it merges. Link it with update_ticket waitsOn add: ["BOS-12"], or reword the text if no wait is meant.',
    );
  });

  it("says nothing when the ticket already waits on the one named", () => {
    expect(unlinkedOrderWarning(["after BOS-12", "once BOS-12 lands"], new Set([12]))).toBe("");
  });

  it("lists several missing tickets once each, in the order they appear, with plural wording", () => {
    const warning = unlinkedOrderWarning(["after BOS-12 and once BOS-7 lands", "waits on BOS-12"], new Set([7]));
    expect(warning).toContain("this comes after BOS-12");
    expect(warning).toContain("no waits-on link to it,");
    expect(warning).toContain('update_ticket waitsOn add: ["BOS-12"]');
    expect(unlinkedOrderWarning(["after BOS-12 and once BOS-7 lands"], new Set())).toContain(
      'after BOS-12, BOS-7, but there is no waits-on link to them, so nothing waits and you will not be woken when they merge. Link them with update_ticket waitsOn add: ["BOS-12", "BOS-7"]',
    );
  });

  it("recognises the wording in any case and keeps the reference upper-case", () => {
    expect(unlinkedOrderWarning(["After hol-3"], new Set())).toContain("after HOL-3");
  });

  it("matches the numbers, so a linked BOS-12 silences BOS-0012", () => {
    expect(unlinkedOrderWarning(["waiting on BOS-0012"], new Set([12]))).toBe("");
  });

  it("ignores prose with no ordering cue, and empty or missing text", () => {
    expect(unlinkedOrderWarning(["BOS-12 is the ticket", null, undefined, ""], new Set())).toBe("");
    expect(unlinkedOrderWarning([], new Set())).toBe("");
  });
});

describe("urgentClaims: which tickets a message calls urgent", () => {
  it("takes a reference near the word as the ticket it means", () => {
    expect(urgentClaims("BOS-12 is urgent")).toEqual({ numbers: [12], unnamed: false });
    expect(urgentClaims("urgent: BOS-5")).toEqual({ numbers: [5], unnamed: false });
  });

  it("treats the word standing alone as an unnamed claim", () => {
    expect(urgentClaims("This is urgent.")).toEqual({ numbers: [], unnamed: true });
    expect(urgentClaims("")).toEqual({ numbers: [], unnamed: false });
  });

  it("counts a reference up to 40 characters away, and not one further off", () => {
    expect(urgentClaims(`BOS-12 ${"x".repeat(28)} urgent`)).toEqual({ numbers: [12], unnamed: false });
    expect(urgentClaims(`BOS-12 ${"x".repeat(50)} urgent`)).toEqual({ numbers: [], unnamed: true });
  });

  it("does not read a negated word as a claim", () => {
    expect(urgentClaims("This is not urgent")).toEqual({ numbers: [], unnamed: false });
    expect(urgentClaims("This is non-urgent")).toEqual({ numbers: [], unnamed: false });
    expect(urgentClaims("This isn't urgent")).toEqual({ numbers: [], unnamed: false });
    expect(urgentClaims("This is non urgent")).toEqual({ numbers: [], unnamed: false });
  });

  it("names every reference near the word, once each", () => {
    expect(urgentClaims("BOS-12 and BOS-7 are urgent")).toEqual({ numbers: [12, 7], unnamed: false });
    expect(urgentClaims("BOS-12 urgent; BOS-12 still urgent")).toEqual({ numbers: [12], unnamed: false });
  });

  it("matches the reference whatever its case", () => {
    expect(urgentClaims("bos-12 is urgent")).toEqual({ numbers: [12], unnamed: false });
  });

  it("does not mistake a bare id or a lonelier echo for a named ticket", () => {
    expect(urgentClaims("3da898f0-96ae-4f9c-9732-923430369a86 is urgent")).toEqual({ numbers: [], unnamed: true });
    expect(urgentClaims(`BOS-12 is urgent ${"x".repeat(50)} and this is urgent too`)).toEqual({ numbers: [12], unnamed: true });
  });
});

describe("criterionLines: the reviewer's checklist", () => {
  const criteria: Criterion[] = ["Tests pass", { text: "Owner sees the button", after: "merge" }];

  it("shows each verdict with the criterion's words, and marks an after-merge check", () => {
    expect(criterionLines(criteria, "1 pass; 2 fail: the button is missing")).toEqual([
      "- [pass] Tests pass",
      "- [fail] Owner sees the button (checked after merge; don't fail the review on it)",
    ]);
  });

  it("says not reported for a criterion the note never settles", () => {
    expect(criterionLines(criteria, null)).toEqual([
      "- [not reported] Tests pass",
      "- [not reported] Owner sees the button (checked after merge; don't fail the review on it)",
    ]);
    expect(criterionLines(criteria, "")).toEqual(criterionLines(criteria, null));
  });

  it("reads a verdict written in the criterion's own words", () => {
    expect(criterionLines(["Tests pass"], "The tests pass on main.")).toEqual(["- [pass] Tests pass"]);
  });

  it("keeps a numbered verdict even when the criterion has no words to match", () => {
    expect(criterionLines(["a"], "1 pass")).toEqual(["- [pass] a"]);
    expect(criterionLines(["a"], "")).toEqual(["- [not reported] a"]);
  });

  it("returns nothing for an empty list", () => {
    expect(criterionLines([], "1 pass")).toEqual([]);
  });
});

describe("the MCP result envelopes", () => {
  it("text wraps an answer as one text item", () => {
    expect(text("hello")).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect("isError" in text("hello")).toBe(false);
  });

  it("fail wraps a refusal as one text item and marks it an error", () => {
    expect(fail("no")).toEqual({ content: [{ type: "text", text: "no" }], isError: true });
  });
});
