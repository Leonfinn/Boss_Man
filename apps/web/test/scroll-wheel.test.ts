import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A wheel over the page must scroll the page (BOS-554). A rule that only sets `overflow-x: auto`
// still computes `overflow-y: auto`, so a strip one pixel taller than its box becomes a vertical
// scroller that swallows the wheel and leaves the page still. Every sideways-only scroller must
// set `overflow-y` too, so the wheel reaches the page; the ones that scroll both ways are left be.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// The body of the single-line rule whose selector is exactly `selector`.
function body(selector: string): string | undefined {
  for (const line of css.split("\n")) {
    const brace = line.indexOf("{");
    if (brace === -1) continue;
    if (line.slice(0, brace).trim() === selector) return line.slice(brace + 1, line.lastIndexOf("}"));
  }
  return undefined;
}

// The sideways-only scrollers: they hold content wider than the box, and their height fits.
const sidewaysOnly = [".board-scroll", ".tabs", ".table-wrap", ".codebox", ".md pre", ".md-table", ".skill-file"];

describe("wheel scrolling over content", () => {
  it("keeps every sideways-only scroller from becoming a vertical one", () => {
    for (const selector of sidewaysOnly) {
      const rule = body(selector);
      expect(rule, `${selector} rule missing from styles.css`).toBeDefined();
      expect(rule, `${selector} should allow sideways scrolling`).toMatch(/overflow-x:\s*auto/);
      expect(rule, `${selector} should set overflow-y: hidden so the wheel reaches the page`).toMatch(/overflow-y:\s*hidden/);
    }
  });

  it("takes the wheel over the tab strip, not a one-pixel vertical overflow", () => {
    // The tabs are the strip whose second scrollbar the owner saw (BOS-554): their buttons carry a
    // 3px bottom border and a -1px margin, so the row is 1px taller than its box without this.
    expect(body(".tabs")).toMatch(/overflow-y:\s*hidden/);
  });
});
