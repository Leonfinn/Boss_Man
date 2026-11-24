// BOS-2511: the screen-change rule's pure parts: what triggers it, what counts as a render test and as screenshots.
import { describe, expect, it } from "vitest";
import { geometryRenderTests, hasBeforeAfterShots, layoutFiles, noVisualChangeProblem, renderCheckRefusal } from "../src/services/render-check-gate.js";

const section = (path: string, lines: string[]) => [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1,3 +1,3 @@", ...lines].join("\n");
const diffOf = (...parts: Array<{ path: string; lines: string[] }>) => ({
  files: parts.map((p) => ({ path: p.path, added: p.lines.filter((l) => l.startsWith("+")).length, removed: p.lines.filter((l) => l.startsWith("-")).length })),
  diff: parts.map((p) => section(p.path, p.lines)).join("\n"),
  truncated: false,
});
const BOARD = "apps/web/src/pages/Board.tsx";
const TEST = "apps/web/test/board-age-render.test.tsx";
const GEOMETRY_TEST = { path: TEST, lines: ["+const box = el.getBoundingClientRect();", "+expect(box.height).toBeLessThan(24);"] };
const SHOTS = [
  { name: "board-before.png", caption: "Board before, 1667 px", byAgent: true },
  { name: "board-after.png", caption: "Board after, 1667 px", byAgent: true },
];

describe("what triggers the rule", () => {
  it("any change to styles.css", () => {
    expect(layoutFiles(diffOf({ path: "apps/web/src/styles.css", lines: ["-  gap: 4px;", "+  gap: 6px;"] }))).toEqual(["apps/web/src/styles.css"]);
  });

  it("page or component JSX: a tag, a className or a style prop", () => {
    expect(layoutFiles(diffOf({ path: BOARD, lines: ['+      <span className="mono state-age">{sa.label}</span>'] }))).toEqual([BOARD]);
    expect(layoutFiles(diffOf({ path: "apps/web/src/components/Card.tsx", lines: ["+  return (<>", "+  </>);"] }))).toEqual(["apps/web/src/components/Card.tsx"]);
    expect(layoutFiles(diffOf({ path: BOARD, lines: ["+  <div style={{ gap: 4 }} />"] }))).toEqual([BOARD]);
    expect(layoutFiles(diffOf({ path: BOARD, lines: ['-  className="a"', '+  className="b"'] }))).toEqual([BOARD]);
  });

  it("not a handler, a generic, a comparison or an import in a page", () => {
    const d = diffOf({ path: BOARD, lines: ["+  const [x, setX] = useState<string>(\"\");", "+  if (a < b) onClick();", '+import { api } from "../api";'] });
    expect(layoutFiles(d)).toEqual([]);
  });

  it("not a .tsx outside pages/components, nor a .ts helper inside them", () => {
    expect(layoutFiles(diffOf({ path: "apps/web/src/App.tsx", lines: ["+<div />"] }, { path: "apps/web/src/pages/board-sort.ts", lines: ["+<div />"] }))).toEqual([]);
  });

  it("a page missing from a truncated diff counts on its path alone", () => {
    const d = { ...diffOf({ path: "apps/web/src/api.ts", lines: ["+x"] }), truncated: true };
    d.files.push({ path: BOARD, added: 3, removed: 0 });
    expect(layoutFiles(d)).toEqual([BOARD]);
  });

  it("a rename is matched by its new path", () => {
    const d = { files: [{ path: "apps/web/src/pages/New.tsx", added: 1, removed: 0 }], diff: ["diff --git a/apps/web/src/pages/Old.tsx b/apps/web/src/pages/New.tsx", "+<p>hi</p>"].join("\n"), truncated: false };
    expect(layoutFiles(d)).toEqual(["apps/web/src/pages/New.tsx"]);
  });
});

describe("what counts as a render test", () => {
  it("a *-render.test whose added lines measure geometry", () => {
    expect(geometryRenderTests(diffOf(GEOMETRY_TEST))).toEqual([TEST]);
    expect(geometryRenderTests(diffOf({ path: "apps/web/test/x-render.test.ts", lines: ["+const overflow = el.scrollWidth - el.clientWidth;"] }))).toEqual(["apps/web/test/x-render.test.ts"]);
    expect(geometryRenderTests(diffOf({ path: "apps/web/test/x-render.test.tsx", lines: ["+const b = await page.locator('.card').boundingBox();"] }))).toEqual(["apps/web/test/x-render.test.tsx"]);
  });

  it("not one that only checks classes exist (BOS-2496), nor geometry in a removed line", () => {
    expect(geometryRenderTests(diffOf({ path: TEST, lines: ["+expect(el.classList.contains('nowrap')).toBe(true);"] }))).toEqual([]);
    expect(geometryRenderTests(diffOf({ path: TEST, lines: ["-const box = el.getBoundingClientRect();", "+// removed"] }))).toEqual([]);
  });

  it("not a geometry test with another name or outside apps/web/test", () => {
    expect(geometryRenderTests(diffOf({ path: "apps/web/test/board.test.tsx", lines: GEOMETRY_TEST.lines }))).toEqual([]);
    expect(geometryRenderTests(diffOf({ path: "apps/server/test/x-render.test.ts", lines: GEOMETRY_TEST.lines }))).toEqual([]);
  });

  it("one a truncated diff never reached counts on its path", () => {
    const d = { ...diffOf({ path: BOARD, lines: ["+<div />"] }), truncated: true };
    d.files.push({ path: TEST, added: 80, removed: 0 });
    expect(geometryRenderTests(d)).toEqual([TEST]);
  });
});

describe("what counts as screenshots", () => {
  it("two agent pictures, one before and one after, by caption or file name", () => {
    expect(hasBeforeAfterShots(SHOTS)).toBe(true);
    expect(hasBeforeAfterShots([{ name: "a.png", caption: "Before: lane header", byAgent: true }, { name: "b.png", caption: "After: lane header", byAgent: true }])).toBe(true);
  });

  it("not one picture named both, only befores, the owner's pastes, or unlabelled shots", () => {
    expect(hasBeforeAfterShots([{ name: "x.png", caption: "before and after", byAgent: true }])).toBe(false);
    expect(hasBeforeAfterShots([SHOTS[0]!, { ...SHOTS[0]!, name: "b2.png" }])).toBe(false);
    expect(hasBeforeAfterShots(SHOTS.map((s) => ({ ...s, byAgent: false })))).toBe(false);
    expect(hasBeforeAfterShots([{ name: "1.png", caption: "board", byAgent: true }, { name: "2.png", caption: "board", byAgent: true }])).toBe(false);
    expect(hasBeforeAfterShots([{ name: "beforehand.png", caption: null, byAgent: true }, { name: "aftermath.png", caption: null, byAgent: true }])).toBe(false);
  });
});

describe("the refusal", () => {
  const layout = diffOf({ path: BOARD, lines: ['+<span className="age" />'] });

  it("no layout change: no refusal, whatever is missing", () => {
    expect(renderCheckRefusal({ diff: diffOf({ path: "apps/server/src/a.ts", lines: ["+x"] }), images: [] })).toBeNull();
  });

  it("names what is missing, the files, the tools and the way out", () => {
    const r = renderCheckRefusal({ diff: layout, images: [] })!;
    expect(r).toContain(BOARD);
    expect(r).toContain("render test");
    expect(r).toContain("before and after screenshots");
    expect(r).toContain("scripts/screenshot.mjs");
    expect(r).toContain("docs/28-browser-checks.md");
    expect(r).toContain("merge-queue-held-render.test.tsx");
    expect(r).toContain("noVisualChange");
  });

  it("with only one half, names only the other", () => {
    const onlyTest = renderCheckRefusal({ diff: diffOf({ path: BOARD, lines: ['+<span className="age" />'] }, GEOMETRY_TEST), images: [] })!;
    expect(onlyTest).toContain("Missing: before and after screenshots");
    const onlyShots = renderCheckRefusal({ diff: layout, images: SHOTS })!;
    expect(onlyShots).toMatch(/Missing: a render test[^;]*\.$/m);
  });

  it("passes with both, or with noVisualChange", () => {
    expect(renderCheckRefusal({ diff: diffOf({ path: BOARD, lines: ['+<span className="age" />'] }, GEOMETRY_TEST), images: SHOTS })).toBeNull();
    expect(renderCheckRefusal({ diff: layout, images: [], noVisualChange: "only the aria-label wording changed" })).toBeNull();
  });

  it("noVisualChange needs a real one-line reason", () => {
    expect(noVisualChangeProblem("n/a")).toMatch(/at least 10/);
    expect(noVisualChangeProblem("only the handler\nchanged here")).toMatch(/one line/);
    expect(noVisualChangeProblem("only the click handler changed")).toBeNull();
  });
});
