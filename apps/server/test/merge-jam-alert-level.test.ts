import { describe, expect, it } from "vitest";
import { firstAlert, reachesOwner } from "../src/services/merge-jam.js";

describe("merge jam alert level (BOS-1340)", () => {
  it("tells the owner the jam above the feed on a flag, a page or an ask", () => {
    for (const level of ["flag", "page", "ask"]) expect(reachesOwner({ level })).toBe(true);
  });

  it("does not count a plain feed note as reaching the owner", () => {
    expect(reachesOwner({ level: "note" })).toBe(false);
    expect(reachesOwner({ level: "" })).toBe(false);
  });

  it("treats the level as case-sensitive, so an upper-case FLAG is not a flag", () => {
    expect(reachesOwner({ level: "FLAG" })).toBe(false);
    expect(reachesOwner({ level: "Page" })).toBe(false);
  });

  it("counts no jam alert at all when nothing was written", () => {
    expect(reachesOwner(null)).toBe(false);
    expect(reachesOwner(undefined)).toBe(false);
  });

  it("puts the line's title after the fixed first-alert words", () => {
    expect(firstAlert({ title: "BOS-12 is stuck behind a slot", body: "Boss Man moves it next." })).toEqual({
      title: "Merges are stuck: BOS-12 is stuck behind a slot",
      body: "Boss Man moves it next.",
    });
  });

  it("passes the body through unchanged, line breaks and all", () => {
    const body = "First line\nSecond line\n\nFourth line";
    expect(firstAlert({ title: "The big merge", body }).body).toBe(body);
  });

  it("passes an empty body and an empty title through unchanged", () => {
    expect(firstAlert({ title: "", body: "" })).toEqual({ title: "Merges are stuck: ", body: "" });
  });
});
