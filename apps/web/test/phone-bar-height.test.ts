import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// BOS-1213: below 641px the menu is a bar above the page. `.side { min-height: 100% }` is for the
// side menu on wide screens; if it reaches the phone bar, the bar stretches tall on short pages.
// This reads the CSS text: it finds every `.side` rule inside a max-width: 640px block and checks
// one of them sets `min-height: 0`, and that no per-page reset has crept back.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** The bodies of every `@media (max-width: 640px) { ... }` block (braces balanced). */
function phoneBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /@media\s*\(max-width:\s*640px\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push(src.slice(re.lastIndex, i - 1));
  }
  return out;
}

describe("the phone top bar keeps its natural height (BOS-1213)", () => {
  it("a general rule below 641px resets .side min-height to 0", () => {
    const rules = phoneBlocks(css).flatMap((b) => [...b.matchAll(/(?:^|[}\/])\s*\.side\s*\{([^}]*)\}/g)].map((x) => x[1]));
    expect(rules.some((r) => /min-height:\s*0\b/.test(r))).toBe(true);
  });

  it("no page-specific reset is needed (the Chat-only rule stays gone)", () => {
    expect(css).not.toMatch(/\.chat-page[^{]*\)\s*>\s*nav\.side\s*\{\s*min-height:\s*0/);
  });
});
