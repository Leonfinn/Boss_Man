import { describe, expect, it } from "vitest";
import { unlinkedOrderWarning } from "../src/mcp-common.js";

describe("unlinkedOrderWarning: an ordering written in prose with no waits-on link", () => {
  it.each(["after BOS-12", "wait on BOS-12", "waits on BOS-12", "waiting on BOS-12", "once BOS-12"])(
    "warns about the ticket named by %j",
    (text) => {
      const warning = unlinkedOrderWarning([text], new Set());
      expect(warning).toContain("Heads-up: the text says this comes after BOS-12");
      expect(warning).toContain('update_ticket waitsOn add: ["BOS-12"]');
    },
  );

  it.each(["after BOS-12", "wait on BOS-12", "waits on BOS-12", "waiting on BOS-12", "once BOS-12"])(
    "says nothing when the ticket already waits on the one named by %j",
    (text) => {
      expect(unlinkedOrderWarning([text], new Set([12]))).toBe("");
    },
  );

  it("names only the unlinked refs when some are linked and some are not", () => {
    const warning = unlinkedOrderWarning(["after BOS-12 and waits on BOS-7", "once BOS-7 lands"], new Set([7]));
    expect(warning).toContain("this comes after BOS-12");
    expect(warning).not.toContain("BOS-7");
    expect(warning).toContain("no waits-on link to it,");
  });

  it("names the same ref once, upper-cased, when it appears in two texts", () => {
    const warning = unlinkedOrderWarning(["after bos-12", "waits on BOS-12"], new Set());
    expect(warning).toContain("this comes after BOS-12");
    expect(warning).not.toContain("BOS-12, BOS-12");
    expect(warning).toContain('update_ticket waitsOn add: ["BOS-12"]');
  });

  it("skips null, undefined and empty texts", () => {
    expect(unlinkedOrderWarning([null, undefined, "", "after BOS-12"], new Set())).toContain("BOS-12");
    expect(unlinkedOrderWarning([null, undefined, ""], new Set())).toBe("");
    expect(unlinkedOrderWarning([], new Set())).toBe("");
  });

  it("recognises a lower-case ref and any prefix, keeping the reference upper-case", () => {
    expect(unlinkedOrderWarning(["after bos-12"], new Set())).toContain("after BOS-12");
    expect(unlinkedOrderWarning(["once hol-3 lands"], new Set())).toContain("after HOL-3");
  });

  it("uses singular wording, and a one-item waitsOn list, for one missing ref", () => {
    expect(unlinkedOrderWarning(["after BOS-12"], new Set())).toBe(
      '\n\nHeads-up: the text says this comes after BOS-12, but there is no waits-on link to it, so nothing waits and you will not be woken when it merges. Link it with update_ticket waitsOn add: ["BOS-12"], or reword the text if no wait is meant.',
    );
  });

  it("uses plural wording, and lists every missing ref, for several missing refs", () => {
    const warning = unlinkedOrderWarning(["after BOS-12 and once BOS-7 lands"], new Set());
    expect(warning).toContain("this comes after BOS-12, BOS-7");
    expect(warning).toContain("no waits-on link to them");
    expect(warning).toContain("when they merge.");
    expect(warning).toContain('update_ticket waitsOn add: ["BOS-12", "BOS-7"]');
  });

  it("says nothing for a ref with no ordering word", () => {
    expect(unlinkedOrderWarning(["BOS-12 is the ticket this depends on"], new Set())).toBe("");
  });

  it("starts with a blank line before the heads-up", () => {
    const warning = unlinkedOrderWarning(["after BOS-12"], new Set());
    expect(warning.startsWith("\n\n")).toBe(true);
    expect(warning.slice(0, 2)).toBe("\n\n");
  });
});
