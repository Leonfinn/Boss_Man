// BOS-1674 (Background lane): the pure helper behind heading anchors in Markdown, which had no
// direct test. A #/wiki/<company>/<slug>#Section link relies on it.
import { describe, expect, it } from "vitest";
import { headingId } from "../src/components/Markdown";

describe("headingId", () => {
  it("lowercases and trims a heading", () => {
    expect(headingId("  Hello World  ")).toBe("hello-world");
  });

  it("drops punctuation so a section link can land", () => {
    expect(headingId("Skipped: class-level-regression-tests (QA agents)")).toBe("skipped-class-level-regression-tests-qa-agents");
    expect(headingId("Rollback?")).toBe("rollback");
  });

  it("collapses runs of whitespace to one dash", () => {
    expect(headingId("A  B\tC\nD")).toBe("a-b-c-d");
  });

  it("keeps digits, underscores and existing hyphens", () => {
    expect(headingId("BOS-1674 and snake_case")).toBe("bos-1674-and-snake_case");
  });

  it("removes apostrophes without leaving a gap", () => {
    expect(headingId("Owner's notes")).toBe("owners-notes");
  });

  it("returns an empty id for a heading with no letters or digits", () => {
    expect(headingId("   ")).toBe("");
    expect(headingId("?!")).toBe("");
  });
});
