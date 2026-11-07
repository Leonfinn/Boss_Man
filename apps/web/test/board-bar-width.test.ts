import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// On a folding phone's inner screen (~720-840 CSS px) the board's filter row made the page wider
// than the window (BOS-567): a select is as wide as its longest option, so one long feature title
// pushed the Feature filter, and the whole page with it, past the right edge, and the search box
// would not go below 220px. Measured in headless Chromium with this stylesheet: the page was 885px
// wide at 724 and 840px windows before, and exactly the window's width after. jsdom does no layout,
// so this pins the rules that keep every box in the row within the window.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const board = readFileSync(new URL("../src/pages/Board.tsx", import.meta.url), "utf8");

// Every declaration block (top-level, single-line rules) whose selector list contains `selector`.
function decls(selector: string): string {
  return css
    .split("\n")
    .filter((line) => {
      const brace = line.indexOf("{");
      return brace !== -1 && line.slice(0, brace).split(",").some((s) => s.trim() === selector);
    })
    .map((line) => line.slice(line.indexOf("{") + 1, line.lastIndexOf("}")))
    .join(";");
}

describe("board filter row fits a narrow window", () => {
  it("lets the row's boxes shrink to the window", () => {
    for (const sel of [".board-bar > div", ".board-bar label"]) {
      expect(decls(sel), sel).toMatch(/min-width:\s*0/);
      expect(decls(sel), sel).toMatch(/max-width:\s*100%/);
    }
  });

  it("caps the filter selects at their row's width however long an option is", () => {
    expect(decls(".board-bar select")).toMatch(/max-width:\s*100%/);
  });

  it("gives the search box a width it can give up, not a hard minimum", () => {
    expect(decls('.board-bar input[type="search"]')).toMatch(/max-width:\s*100%/);
    expect(board).not.toMatch(/type="search"[^>]*minWidth/);
  });
});
