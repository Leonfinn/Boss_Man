import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The side menu fills the window and stays put while the page scrolls (BOS-289). The rule lives in
// a media query that turns on wherever the menu sits beside the page, and sizes with 100dvh so a
// mobile browser's address bar showing or hiding doesn't reopen a gap at the bottom.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// Return the body of every rule whose selector list contains `selector`, with the media condition
// it sits under (null at the top level). Enough for these plain single-line rules.
function rules(selector: string, exact = false) {
  const found: { at: string | null; body: string }[] = [];
  const re = /@media\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/g;
  for (let m; (m = re.exec(css)); ) {
    const at = m[1] ?? null;
    const body = m[2] ?? "";
    for (const line of body.split("\n")) {
      const sel = line.slice(0, line.indexOf("{")).trim();
      if (exact ? sel === selector : line.trim().startsWith(selector + " ")) found.push({ at, body: line.slice(line.indexOf("{") + 1, line.lastIndexOf("}")) });
    }
  }
  return found;
}

const side = () => {
  const [only] = rules(".app > nav.side");
  if (!only) throw new Error("sidebar height rule missing from styles.css");
  return only;
};

describe("side menu height", () => {
  it("turns on just above the 640px phone layout, where the menu sits beside the page", () => {
    expect(rules(".app > nav.side", true)).toHaveLength(1);
    expect(side().at).toBe("min-width: 641px");
  });

  it("fills the whole window with 100vh, not the shorter dynamic viewport", () => {
    // BOS-599: on a phone browser whose toolbar is showing, 100dvh is shorter than the window, so
    // a menu sized with it ends above the bottom edge and leaves a blank strip. 100vh follows the
    // window itself, so the column always reaches the bottom; its contents scroll inside it.
    const decls = side().body.split(";").map((d) => d.trim()).filter(Boolean);
    const heights = decls.filter((d) => d.startsWith("height:")).map((d) => d.slice("height:".length).trim());
    expect(heights).toEqual(["100vh"]);
    expect(side().body).not.toContain("dvh");
  });

  it("stays in view while the page scrolls and scrolls its own overflow", () => {
    const body = side().body;
    expect(body).toContain("position: sticky");
    expect(body).toContain("top: 0");
    expect(body).toContain("align-self: flex-start");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overflow-y: auto");
  });

  it("keeps the menu beside the page, not wrapped above it, from 641px up", () => {
    // The shell must not wrap at this width, and the menu must keep a fixed column so it and the
    // page share one row instead of the menu taking the whole screen on a row of its own.
    const [shell] = rules(".app", true);
    if (!shell) throw new Error(".app no-wrap rule missing from styles.css");
    expect(shell.at).toBe("min-width: 641px");
    expect(shell.body).toContain("flex-wrap: nowrap");
    expect(side().body).toContain("flex: 0 0 232px");
    const main = rules(".app > main", true).find((r) => r.at === "min-width: 641px");
    expect(main?.at).toBe("min-width: 641px");
    expect(main?.body).toContain("flex: 1 1 0");
  });

  it("narrows the menu to an icon strip when collapsed, inside the same beside-the-page layout (BOS-290)", () => {
    const [strip] = rules(".app.side-collapsed > nav.side");
    if (!strip) throw new Error("collapsed sidebar width rule missing from styles.css");
    expect(strip.at).toBe("min-width: 641px");
    expect(strip.body).toContain("flex: 0 0 64px");
    // The expanded menu keeps its 232px column, so the strip only swaps the width.
    expect(side().body).toContain("flex: 0 0 232px");
  });

  it("leaves the phone bar above the page alone", () => {
    // The max-width 640px block must not pin the menu's height.
    const blocks = css.match(/@media\s*\(max-width: 640px\)\s*\{([\s\S]*?)\n\}/g) ?? [];
    for (const block of blocks) expect(block).not.toMatch(/\.app > nav\.side/);
  });
});
