import { describe, expect, it } from "vitest";
import { cleanFolder, linkedSlugs, pageSlug, WikiError } from "../src/services/wiki.js";

// BOS-1234: the folder clean-up, page addresses and the slugs a page body links to. A wiki write turns
// a folder and title into an address with cleanFolder/pageSlug, and "what links here" comes from
// linkedSlugs; none of the three had a test.

describe("cleanFolder", () => {
  it("trims parts, keeps capitals and drops empty parts", () => {
    expect(cleanFolder(" research / Competitors/ ")).toBe("research/Competitors");
    expect(cleanFolder("/research//Competitors/")).toBe("research/Competitors");
  });

  it("shrinks runs of spaces inside a part to one", () => {
    expect(cleanFolder("research   notes")).toBe("research notes");
    expect(cleanFolder("  research \t notes  ")).toBe("research notes");
  });

  it("cuts each part to 60 characters", () => {
    expect(cleanFolder("x".repeat(70))).toBe("x".repeat(60));
    expect(cleanFolder(`${"a".repeat(70)}/${"b".repeat(70)}`)).toBe(`${"a".repeat(60)}/${"b".repeat(60)}`);
  });

  it("allows six levels", () => {
    expect(cleanFolder("a/b/c/d/e/f")).toBe("a/b/c/d/e/f");
  });

  it("refuses seven levels with a 400 WikiError", () => {
    let caught: unknown;
    try {
      cleanFolder("a/b/c/d/e/f/g");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WikiError);
    expect((caught as WikiError).status).toBe(400);
  });

  it("gives an empty folder for empty input", () => {
    expect(cleanFolder("")).toBe("");
  });
});

describe("pageSlug", () => {
  it("turns a folder and name into a lowercase address", () => {
    expect(pageSlug("Research/Competitors", "Paperclip")).toBe("research/competitors/paperclip");
  });

  it("uses just the name's slug for an empty folder", () => {
    expect(pageSlug("", "Paperclip")).toBe("paperclip");
  });

  it("drops punctuation and collapses runs of spaces, underscores and hyphens to one hyphen", () => {
    expect(pageSlug("", "A  paper__clip--idea!")).toBe("a-paper-clip-idea");
  });

  it("uses 'page' for a name made only of punctuation", () => {
    expect(pageSlug("", "!!!")).toBe("page");
  });

  it("cuts each part to 80 characters", () => {
    expect(pageSlug("", "a".repeat(100))).toBe("a".repeat(80));
    expect(pageSlug("x".repeat(100), "Name")).toBe(`${"x".repeat(80)}/name`);
  });
});

describe("linkedSlugs", () => {
  it("returns the slugs linked in a body, in order and without repeats", () => {
    expect(linkedSlugs("[[a]] [[b#Some heading]] [[a]]")).toEqual(["a", "b"]);
  });

  it("trims spaces inside the brackets", () => {
    expect(linkedSlugs("see [[ a ]] and [[  b#Section ]]")).toEqual(["a", "b"]);
  });

  it("returns nothing for text with no links", () => {
    expect(linkedSlugs("plain text with [single brackets] and no wiki links")).toEqual([]);
  });
});
