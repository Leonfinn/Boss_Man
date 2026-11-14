import { describe, expect, it } from "vitest";
import { pageDiff } from "../src/services/review-diff-page.js";

const file = (p: string, n: number) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n")}\n`;

describe("pageDiff", () => {
  const diff = file("a.ts", 5) + file("b.ts", 50) + file("c.ts", 5);

  it("returns a short diff whole, with no cut note", () => {
    expect(pageDiff({ diff }).text).toBe(diff);
  });

  it("cuts on a whole line and names what is left", () => {
    const r = pageDiff({ diff, limit: 200 });
    expect(r.text).toContain("DIFF CUT HERE");
    expect(r.text).toContain("b.ts (rest of this file), c.ts");
    expect(r.text).toMatch(/\d+ line\(s\) not shown/);
    expect(r.text.split("\n[DIFF CUT")[0]!.endsWith("\n") || r.text.split("\n[DIFF CUT")[0]!.match(/\+line \d+$/)).toBeTruthy();
  });

  it("paging by the offset in the note reads everything exactly once", () => {
    let offset = 0;
    let got = "";
    for (let i = 0; i < 50; i++) {
      const r = pageDiff({ diff, limit: 150, offset });
      const m = /offset (\d+)\. Call|offset (\d+) for the next/.exec(r.text);
      const cut = r.text.indexOf("\n[DIFF CUT HERE");
      if (cut < 0) { got += r.text.replace(/\n\[End of the diff.*$/s, ""); break; }
      got += r.text.slice(0, cut);
      offset = Number(/with offset (\d+) for/.exec(r.text)![1]);
      void m;
    }
    expect(got).toBe(diff);
  });

  it("reads one file by path, and pages inside it", () => {
    const r = pageDiff({ diff, path: "b.ts" });
    expect(r.text).toContain("diff --git a/b.ts");
    expect(r.text).not.toContain("a.ts");
    expect(pageDiff({ diff, path: "b.ts", limit: 100 }).text).toContain('path "b.ts" offset');
  });

  it("refuses an unknown file or a bad offset", () => {
    expect(pageDiff({ diff, path: "z.ts" }).error).toContain("a.ts");
    expect(pageDiff({ diff, offset: 999999 }).error).toContain("outside");
  });
});
