// BOS-2511 (DR-075): the screen-change rule's pure parts: what triggers it, what counts as a render test and as screenshots.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// The writer scripts/screenshot.mjs uses, so writer and reader can't drift apart.
import { addPngText, SCREENSHOT_MARKER_KEY as WRITER_KEY, SCREENSHOT_MARKER_SEEDED as WRITER_VALUE } from "../../../scripts/png-marker.mjs";
import { hasBeforeAfterShots, hasSeededMarker, isBrowserRenderTest, layoutFiles, noVisualChangeProblem, renderCheckRefusal, renderTestCandidates, SCREENSHOT_MARKER_KEY, SCREENSHOT_MARKER_SEEDED, type ShotFacts } from "../src/services/render-check-gate.js";

const section = (path: string, lines: string[]) => [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1,3 +1,3 @@", ...lines].join("\n");
const diffOf = (...parts: Array<{ path: string; lines: string[] }>) => ({
  files: parts.map((p) => ({ path: p.path, added: p.lines.filter((l) => l.startsWith("+")).length, removed: p.lines.filter((l) => l.startsWith("-")).length })),
  diff: parts.map((p) => section(p.path, p.lines)).join("\n"),
  truncated: false,
});
const BOARD = "apps/web/src/pages/Board.tsx";
const TEST = "apps/web/test/board-age-render.test.tsx";
// The BOS-1078 template on main: the test the refusal points authors at must itself count.
const TEMPLATE = readFileSync(new URL("../../web/test/merge-queue-held-render.test.tsx", import.meta.url), "utf8");
const shot = (caption: string, over: Partial<ShotFacts> = {}): ShotFacts => ({ name: "shot.png", caption, byAgent: true, seeded: true, sinceStart: true, ...over });
const SHOTS = [shot("Board before, 1667 px"), shot("Board after, 1667 px")];
// A 1x1 PNG: signature, IHDR, IDAT, IEND.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082", "hex");

describe("what triggers the rule", () => {
  it("any change to styles.css or App.tsx", () => {
    expect(layoutFiles(diffOf({ path: "apps/web/src/styles.css", lines: ["-  gap: 4px;", "+  gap: 6px;"] }))).toEqual(["apps/web/src/styles.css"]);
    expect(layoutFiles(diffOf({ path: "apps/web/src/App.tsx", lines: ["+  const x = 1;"] }))).toEqual(["apps/web/src/App.tsx"]);
  });

  it("page or component JSX: a tag, a fragment, a className or a style prop", () => {
    expect(layoutFiles(diffOf({ path: BOARD, lines: ['+      <span className="mono state-age">{sa.label}</span>'] }))).toEqual([BOARD]);
    expect(layoutFiles(diffOf({ path: "apps/web/src/components/Card.tsx", lines: ["+  return (<>", "+  </>);"] }))).toEqual(["apps/web/src/components/Card.tsx"]);
    expect(layoutFiles(diffOf({ path: BOARD, lines: ["+  <div style={{ gap: 4 }} />"] }))).toEqual([BOARD]);
    expect(layoutFiles(diffOf({ path: BOARD, lines: ['-  className="a"', '+  className="b"'] }))).toEqual([BOARD]);
  });

  it("not a handler, a generic, a comparison or an import in a page", () => {
    const d = diffOf({ path: BOARD, lines: ['+  const [x, setX] = useState<string>("");', "+  if (a < b) onClick();", '+import { api } from "../api";'] });
    expect(layoutFiles(d)).toEqual([]);
  });

  it("not an entry point, nor a .ts helper inside pages", () => {
    expect(layoutFiles(diffOf({ path: "apps/web/src/main.tsx", lines: ["+<div />"] }, { path: "apps/web/src/lazy-page.tsx", lines: ["+<div />"] }, { path: "apps/web/src/pages/board-sort.ts", lines: ["+<div />"] }))).toEqual([]);
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
  it("candidates are changed or added *-render.test files under apps/web/test, not deletions or other names", () => {
    const d = diffOf({ path: TEST, lines: ["+x"] }, { path: "apps/web/test/gone-render.test.ts", lines: ["-x"] }, { path: "apps/web/test/board.test.tsx", lines: ["+x"] }, { path: "apps/server/test/x-render.test.ts", lines: ["+x"] });
    expect(renderTestCandidates(d)).toEqual([TEST]);
  });

  it("the BOS-1078 template counts: styles.css, a real browser and geometry", () => {
    expect(isBrowserRenderTest(TEMPLATE)).toBe(true);
  });

  it("a jsdom test with a geometry call doesn't, nor a browser test that only checks classes, nor one without the stylesheet", () => {
    expect(isBrowserRenderTest('import "../src/styles.css";\nconst r = el.getBoundingClientRect();')).toBe(false);
    expect(isBrowserRenderTest('import { chromium } from "playwright";\nconst css = read("styles.css");\nexpect(el.classList.contains("nowrap")).toBe(true);')).toBe(false);
    expect(isBrowserRenderTest('import { chromium } from "playwright";\nconst b = await el.boundingBox();')).toBe(false);
  });
});

describe("what counts as screenshots", () => {
  it("the marker scripts/screenshot.mjs writes is the one the server reads", () => {
    expect([WRITER_KEY, WRITER_VALUE]).toEqual([SCREENSHOT_MARKER_KEY, SCREENSHOT_MARKER_SEEDED]);
    const marked = addPngText(PNG, WRITER_KEY, WRITER_VALUE);
    expect(hasSeededMarker(marked)).toBe(true);
    expect(hasSeededMarker(new Uint8Array(marked.subarray(0, 200)))).toBe(true); // the caller reads only a prefix
  });

  it("no marker: a plain PNG, another key or value, a JPEG, garbage", () => {
    expect(hasSeededMarker(PNG)).toBe(false);
    expect(hasSeededMarker(addPngText(PNG, "Software", "api=seeded"))).toBe(false);
    expect(hasSeededMarker(addPngText(PNG, WRITER_KEY, "api=none"))).toBe(false);
    expect(hasSeededMarker(Buffer.from("ffd8ffe000104a464946", "hex"))).toBe(false);
    expect(hasSeededMarker(Buffer.from("not an image"))).toBe(false);
  });

  it("two marked agent pictures since the start, one before and one after, by caption or file name", () => {
    expect(hasBeforeAfterShots(SHOTS)).toBe(true);
    expect(hasBeforeAfterShots([shot("", { name: "board-before.png" }), shot("", { name: "board-after.png" })])).toBe(true);
  });

  it("not unmarked (a mock-up), older than the ticket's start, the owner's, one named both, or unlabelled", () => {
    expect(hasBeforeAfterShots([SHOTS[0]!, shot("Board after", { seeded: false })])).toBe(false);
    expect(hasBeforeAfterShots([shot("Board before", { sinceStart: false }), SHOTS[1]!])).toBe(false);
    expect(hasBeforeAfterShots(SHOTS.map((s) => ({ ...s, byAgent: false })))).toBe(false);
    expect(hasBeforeAfterShots([shot("before and after")])).toBe(false);
    expect(hasBeforeAfterShots([shot("board"), shot("board")])).toBe(false);
    expect(hasBeforeAfterShots([shot("", { name: "beforehand.png" }), shot("", { name: "aftermath.png" })])).toBe(false);
  });
});

describe("the refusal", () => {
  const layout = [BOARD];
  const good = [{ path: TEST, text: TEMPLATE }];

  it("no layout change: no refusal", () => {
    expect(renderCheckRefusal({ layout: [], tests: [], images: [] })).toBeNull();
  });

  it("names what is missing, the files, the tools and the way out", () => {
    const r = renderCheckRefusal({ layout, tests: [], images: [] })!;
    for (const s of [BOARD, "render test", '"before" and "after" screenshots', "scripts/screenshot.mjs", "docs/28-browser-checks.md", "merge-queue-held-render.test.tsx", "noVisualChange"]) expect(r).toContain(s);
  });

  it("with only one half, names only the other; says which test or picture didn't count and why", () => {
    expect(renderCheckRefusal({ layout, tests: good, images: [] })!).toMatch(/Missing: "before" and "after" screenshots[^;]*\.$/m);
    expect(renderCheckRefusal({ layout, tests: [{ path: TEST, text: "jsdom only" }], images: SHOTS })!).toContain(`${TEST} doesn't`);
    expect(renderCheckRefusal({ layout, tests: [{ path: TEST, text: null }], images: SHOTS })!).toContain(`couldn't read ${TEST}`);
    expect(renderCheckRefusal({ layout, tests: good, images: [shot("before", { seeded: false }), shot("after", { seeded: false })] })!).toContain("2 pictures attached don't count");
  });

  it("passes with a counting test and marked shots", () => {
    expect(renderCheckRefusal({ layout, tests: [{ path: "apps/web/test/x-render.test.ts", text: null }, ...good], images: SHOTS })).toBeNull();
  });

  it("noVisualChange needs a real one-line reason", () => {
    expect(noVisualChangeProblem("n/a")).toMatch(/at least 10/);
    expect(noVisualChangeProblem("only the handler\nchanged here")).toMatch(/one line/);
    expect(noVisualChangeProblem("only the click handler changed")).toBeNull();
  });
});
