import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A folded Work panel is a one-line card and must never take the main column (BOS-485). On a tablet or an
// unfolded foldable the panel comes last in the source, and a bare grid hands the 1fr share to the last
// column, which crushed the description into about 200px. The folded layout places each side explicitly.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const rule = (selector: string) => {
  const at = css.indexOf(selector + " {");
  if (at < 0) throw new Error(`rule missing: ${selector}`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
};

describe("ticket page layout for a folded Work panel", () => {
  it("keeps the description in the main column and the folded panel in the narrow one", () => {
    expect(rule(".ticket-layout.props-collapsed > .ticket-main")).toContain("grid-column: 1");
    expect(rule(".ticket-layout.props-collapsed > .ticket-props")).toContain("grid-column: 2");
  });

  it("leaves the folded panel column as wide as its content, not the 290px of the open desktop grid", () => {
    expect(rule(".ticket-layout.props-collapsed")).toContain("minmax(0, 1fr) auto");
  });

  it("returns to one column at the stacking width, so nothing squeezes the description", () => {
    // The brace stops this matching a longer query such as "(max-width: 900px), (max-height: 800px)".
    const start = css.indexOf("@media (max-width: 900px) {");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("\n}", start));
    expect(block).toContain(".ticket-layout.props-collapsed > .ticket-main, .ticket-layout.props-collapsed > .ticket-props { grid-column: 1; grid-row: auto; }");
  });

  it("keeps the two-column desktop grid otherwise", () => {
    expect(rule(".ticket-layout")).toContain("minmax(0, 1fr) 290px");
  });
});
