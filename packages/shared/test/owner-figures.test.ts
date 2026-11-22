import { describe, expect, it } from "vitest";
import { figureText, OWNER_FIGURES, slowLineCounts, type OwnerFigureName } from "../src/owner-figures.js";

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

// slowLineCounts is the merging-slowly line both the server note and the web banner show: the count
// Boss Man can move (waiting) and, only when the line is longer than that, the whole line's count.
describe("slowLineCounts: the merging-slowly sentence's figures", () => {
  it("shows only Boss Man's count when the line is empty or no one is waiting behind", () => {
    expect(slowLineCounts({ waiting: 0 })).toBe("0 for Boss Man to merge");
    expect(slowLineCounts({ waiting: 0, inQueue: 0 })).toBe("0 for Boss Man to merge");
  });

  it("shows only Boss Man's count when every ticket in the line is his to merge", () => {
    expect(slowLineCounts({ waiting: 5, inQueue: 5 })).toBe("5 for Boss Man to merge");
    expect(slowLineCounts({ waiting: 1, inQueue: 9 })).toBe(
      "1 for Boss Man to merge (9 in the merge line; the rest are merging now or with an agent or you)",
    );
  });

  it("names both figures and where the rest are when some are not Boss Man's", () => {
    expect(slowLineCounts({ waiting: 3, inQueue: 8 })).toBe(
      "3 for Boss Man to merge (8 in the merge line; the rest are merging now or with an agent or you)",
    );
  });

  it("names both figures when the whole line is slow and none of it is Boss Man's", () => {
    expect(slowLineCounts({ waiting: 0, inQueue: 4 })).toBe(
      "0 for Boss Man to merge (4 in the merge line; the rest are merging now or with an agent or you)",
    );
  });

  it("adds the whole-line figure only when it is strictly longer: at the threshold it stays quiet", () => {
    expect(slowLineCounts({ waiting: 4, inQueue: 4 })).toBe("4 for Boss Man to merge");
    expect(slowLineCounts({ waiting: 4, inQueue: 5 })).toBe(
      "4 for Boss Man to merge (5 in the merge line; the rest are merging now or with an agent or you)",
    );
    expect(slowLineCounts({ waiting: 4, inQueue: 3 })).toBe("4 for Boss Man to merge");
  });

  it("writes each figure with its one label, so no count is renamed here", () => {
    expect(slowLineCounts({ waiting: 21 })).toContain(figureText("mergeQueue.forBossMan", 21));
    expect(slowLineCounts({ waiting: 21, inQueue: 31 })).toContain(figureText("mergeQueue.inLine", 31));
  });
});
