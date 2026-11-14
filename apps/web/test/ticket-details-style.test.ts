import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The look of the "?" and the Details card is in styles.css, which jsdom can't lay out. These checks read the
// rules that the owner's screens depend on: a 44px tap area on touch, 44px+ rows, counts that never wrap, and the
// label column that lets "Assigned to ?" fit on one line (BOS-1195).
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** The body of the rule whose selector line is exactly `selector`. */
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`rule missing: ${selector}`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
};
/** Every media block for `query`, as one string, so a rule can be found wherever it was put. */
const media = (query: string) => {
  const blocks: string[] = [];
  for (let at = css.indexOf(`@media ${query}`); at >= 0; at = css.indexOf(`@media ${query}`, at + 1)) {
    let depth = 0;
    const open = css.indexOf("{", at);
    let i = open;
    for (; i < css.length; i++) {
      depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
      if (depth === 0) break;
    }
    blocks.push(css.slice(open + 1, i));
  }
  return blocks.join("\n");
};

describe("field help and Details card styles (BOS-1195)", () => {
  it("gives the ? a 44px tap area on touch and a phone, without growing the circle", () => {
    const touch = media("(pointer: coarse), (max-width: 640px)");
    expect(touch).toContain(".field-help::after { inset: -11px; }");
    expect(rule(".field-help")).toContain("width: 22px");
    expect(rule(".field-help")).toContain("height: 22px");
    // 22 + 11 on each side is 44.
    expect(rule(".field-help::after")).toContain("inset: 0");
  });

  it("gives the pop-over's close button a 44px target on touch", () => {
    expect(media("(pointer: coarse), (max-width: 640px)")).toContain(".help-pop-close { width: 44px; height: 44px; }");
  });

  it("keeps Details rows at least 44px tall, and counts on one line cut off with …", () => {
    expect(rule(".detail-row > summary")).toContain("min-height: 48px");
    expect(media("(max-width: 640px)")).toContain(".detail-row > summary { min-height: 44px; }");
    const count = rule(".detail-count");
    expect(count).toContain("white-space: nowrap");
    expect(count).toContain("text-overflow: ellipsis");
  });

  it("widens the Work panel's label column to 100px so \"Assigned to ?\" fits", () => {
    expect(rule(".ticket-props dl")).toContain("100px minmax(0, 1fr)");
  });

  it("draws the chevron in CSS and stops it moving for reduced motion", () => {
    expect(rule(".detail-row > summary::before")).toContain("border-right");
    expect(media("(prefers-reduced-motion: reduce)")).toContain(".detail-row > summary::before { transition: none; }");
  });
});
