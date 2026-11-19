import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// BOS-1921: jsdom applies no media queries, so this reads the CSS text and pins the column count of
// `.portal-list` at each width: 1 column by default (phones), 2 from 700px, 3 from 1100px.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** grid-template-columns that applies at a given width: base rule, then each matching min-width block in order. */
function columnsAt(width: number): string {
  let cols = "";
  const base = /\n\.portal-list\s*\{([^}]*)\}/.exec(css);
  const m0 = base && /grid-template-columns:\s*([^;]+);/.exec(base[1]);
  if (m0) cols = m0[1].trim();
  const re = /@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*\.portal-list\s*\{([^}]*)\}\s*\}/g;
  const blocks: { min: number; cols: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const c = /grid-template-columns:\s*([^;]+);/.exec(m[2]);
    if (c) blocks.push({ min: Number(m[1]), cols: c[1].trim() });
  }
  blocks.sort((a, b) => a.min - b.min);
  for (const b of blocks) if (width >= b.min) cols = b.cols;
  return cols;
}

it("BOS-1921: portal tiles are 1 column on phones, 2 on tablets, 3 on desktop", () => {
  expect(columnsAt(380)).toBe("minmax(0, 1fr)");
  expect(columnsAt(699)).toBe("minmax(0, 1fr)");
  expect(columnsAt(700)).toBe("repeat(2, minmax(0, 1fr))");
  expect(columnsAt(1024)).toBe("repeat(2, minmax(0, 1fr))");
  expect(columnsAt(1100)).toBe("repeat(3, minmax(0, 1fr))");
  expect(columnsAt(1667)).toBe("repeat(3, minmax(0, 1fr))");
});

it("BOS-1921: the portal container is wide enough for three tiles", () => {
  const m = /\n\.portal\s*\{[^}]*max-width:\s*(\d+)px/.exec(css);
  expect(m && Number(m[1])).toBeGreaterThanOrEqual(1100);
});
