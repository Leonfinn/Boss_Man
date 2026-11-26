// BOS-2725 (Background lane): the "no size" note on a roadmap row and the key → card action lookup.
import { describe, expect, it } from "vitest";
import { cardActionFor } from "../src/shortcut-list";
import { unsizedNote } from "../src/pages/RoadmapRows";

describe("unsizedNote", () => {
  it("uses the singular wording for one ticket", () => {
    expect(unsizedNote(1)).toBe("1 ticket has no size yet, so it isn't counted (the CEO sizes it)");
  });

  it("uses the plural wording with the number for two and seven tickets", () => {
    expect(unsizedNote(2)).toBe("2 tickets have no size yet, so they aren't counted (the CEO sizes them)");
    expect(unsizedNote(7)).toBe("7 tickets have no size yet, so they aren't counted (the CEO sizes them)");
  });

  it("uses the plural wording for zero (today's behaviour)", () => {
    expect(unsizedNote(0)).toBe("0 tickets have no size yet, so they aren't counted (the CEO sizes them)");
  });
});

describe("cardActionFor", () => {
  it("maps the shared card keys to their actions", () => {
    expect(cardActionFor("j")).toBe("next");
    expect(cardActionFor("k")).toBe("prev");
    expect(cardActionFor("Enter")).toBe("open");
  });

  it("returns null for a key no screen row uses", () => {
    expect(cardActionFor("x")).toBeNull();
    expect(cardActionFor("?")).toBeNull();
    expect(cardActionFor("")).toBeNull();
  });

  it("is case-sensitive, so an uppercase key does nothing (today's behaviour)", () => {
    expect(cardActionFor("J")).toBeNull();
  });
});
