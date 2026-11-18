import { describe, expect, it } from "vitest";
import { figureText, OWNER_FIGURES, type OwnerFigureName } from "../src/owner-figures.js";

// R43 (BOS-1716): the 17 Nov badge said 31 and the banner "21 merge checks waiting": two figures, one word.
const names = Object.keys(OWNER_FIGURES) as OwnerFigureName[];
const labels = (name: OwnerFigureName) => [0, 1, 2, 31].map((n) => figureText(name, n).toLowerCase());

describe("owner-visible figures: one name, one label each (R43)", () => {
  it("no figure's label word appears in another figure's label", () => {
    const clashes: string[] = [];
    for (const a of names) {
      const word = OWNER_FIGURES[a].word.toLowerCase();
      for (const b of names) {
        if (a !== b && labels(b).some((l) => l.includes(word))) clashes.push(`${a}'s word "${word}" is in ${b}'s label "${figureText(b, 2)}"`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("every label carries its own word and its number", () => {
    for (const name of names) {
      const f = OWNER_FIGURES[name];
      for (const l of labels(name)) expect(l, name).toContain(f.word.toLowerCase());
      // The stuck flag is a yes/no (always 1 when shown); every other label states its count.
      if (name !== "mergeQueue.lineStuck") expect(figureText(name, 31), name).toContain("31");
    }
  });

  it("no two figures share a label, and every figure names its server source and where it shows", () => {
    expect(new Set(names.map((n) => figureText(n, 2))).size).toBe(names.length);
    for (const name of names) {
      expect(OWNER_FIGURES[name].source, name).toMatch(/^GET \/api\//);
      expect(OWNER_FIGURES[name].places.length, name).toBeGreaterThan(0);
    }
  });

  it("the plain word 'waiting' names no count: it is what both 17 Nov figures said", () => {
    for (const name of names) for (const l of labels(name)) expect(l, name).not.toMatch(/\bwaiting\b/);
  });
});
