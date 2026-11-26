// BOS-2709: the owner terms list, the glossary that must carry it, and the "New words:" line.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { glossaryLine, newWordsLine, newWordsProblem, ownerTerm, OWNER_TERMS, OWNER_TERM_MIN_CHARS, ownerTermsIn, touchesOwnerScreen } from "../src/owner-terms.js";

describe("the list", () => {
  it("gives every term a plain meaning, a unique id and a pattern that finds its own word", () => {
    expect(new Set(OWNER_TERMS.map((t) => t.id)).size).toBe(OWNER_TERMS.length);
    for (const t of OWNER_TERMS) {
      expect(t.meaning.length, t.id).toBeGreaterThanOrEqual(OWNER_TERM_MIN_CHARS);
      expect(t.pattern.test(t.term), t.id).toBe(true);
    }
  });
  it("has points, found by id or by the words", () => {
    expect(ownerTerm("points")?.meaning).toMatch(/how big a ticket/i);
    expect(ownerTerm("No size")?.id).toBe("no-size");
    expect(ownerTermsIn("13 points left").map((t) => t.id)).toEqual(["points"]);
  });
  it("is carried word for word by the website glossary", () => {
    const glossary = readFileSync(new URL("../../../apps/site/src/guides/glossary.md", import.meta.url), "utf8");
    for (const t of OWNER_TERMS) {
      const line = glossaryLine(t);
      if (line) expect(glossary, `glossary entry for ${t.id}`).toContain(line);
    }
  });
});

describe("New words line", () => {
  it("reads none, or the words named", () => {
    expect(newWordsLine("ok\nNew words: none")).toEqual({ none: true, words: [] });
    expect(newWordsLine("New words: None.")).toEqual({ none: true, words: [] });
    expect(newWordsLine("New words: points, \"pace\", and no size")?.words).toEqual(["points", "pace", "no size"]);
    expect(newWordsLine("no line here")).toBeNull();
    expect(newWordsLine("New words:")).toBeNull();
  });
  it("is refused when missing, or when a word is not in the list", () => {
    expect(newWordsProblem("fine")).toMatch(/New words:/);
    expect(newWordsProblem("New words: none")).toBeNull();
    expect(newWordsProblem("New words: points, no size")).toBeNull();
    expect(newWordsProblem("New words: velocity")).toMatch(/"velocity".*not in the owner terms list/);
  });
  it("applies to web pages and components only", () => {
    expect(touchesOwnerScreen(["apps/web/src/pages/Roadmap.tsx"])).toBe(true);
    expect(touchesOwnerScreen(["apps/web/src/components/Term.tsx"])).toBe(true);
    expect(touchesOwnerScreen(["apps/web/src/api.ts", "apps/web/test/a.test.tsx", "apps/server/src/a.ts"])).toBe(false);
  });
});
