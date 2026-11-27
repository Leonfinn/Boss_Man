// DR-078 (BOS-2798): the raise-time hand-over check matches phrases ("in my note", "pasted", "link below", "attached"),
// never bare words, so none of Boss Man's own card options may trip it. This reads every option list in the server's
// and shared code (system cards, deploy and merge cards, the watchdog's, R19's SCREEN_DIFFERENT_OPTION), resolves the
// constants they name, and runs the rule over each string. The only option that promises a hand-over is R19's, and its
// to-do flags it (attachOptions), so the rule asks for the picture rather than refusing the card.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handOverRefusal, promisedHandOver } from "@boss-man/shared";
import { SCREEN_DIFFERENT_OPTION } from "../src/services/steps.js";

const ROOTS = [new URL("../src", import.meta.url).pathname, new URL("../../../packages/shared/src", import.meta.url).pathname];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
  });
}
const sources = ROOTS.flatMap(files).map((p) => readFileSync(p, "utf8"));

/** Plain string literals in a piece of code: "x", 'x', and `x` with no ${}. */
const literals = (code: string) => [...code.matchAll(/"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`([^`$\\]*)`/g)].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1"));

/** The text inside the [...] that starts at `from`, brackets balanced. */
function bracketed(code: string, from: number): string {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "[") depth++;
    else if (code[i] === "]" && --depth === 0) return code.slice(from, i + 1);
  }
  return "";
}

// Constants an option list may name: `const NAME = "text"` and `const NAME = [ ... ]`.
const consts = new Map<string, string[]>();
for (const code of sources) {
  for (const m of code.matchAll(/\bconst\s+([A-Z][A-Z0-9_]+)\s*(?::[^=\n]+)?=\s*/g)) {
    const at = m.index! + m[0].length;
    if (code[at] === "[") consts.set(m[1]!, [bracketed(code, at)]);
    else {
      const lit = /^(?:"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`([^`$\\]*)`)/.exec(code.slice(at));
      if (lit) consts.set(m[1]!, [(lit[1] ?? lit[2] ?? lit[3] ?? "").replace(/\\(.)/g, "$1")]);
    }
  }
}

function resolve(code: string, seen = new Set<string>()): string[] {
  const out = literals(code);
  for (const [name] of code.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    if (seen.has(name) || !consts.has(name)) continue;
    seen.add(name);
    for (const v of consts.get(name)!) out.push(...(v.startsWith("[") ? resolve(v, seen) : [v]));
  }
  return out;
}

// Every `options: [...]` / `options = [...]` (also behind a ternary: `options: reassign ? [A] : [B]`) and `options: NAME`.
const ownOptions = new Set<string>();
for (const code of sources) {
  for (const m of code.matchAll(/\boptions\??\s*[:=]\s*/g)) {
    const at = m.index! + m[0].length;
    const head = code.slice(at, at + 200).split(/[;\n]/)[0]!;
    if (/^[A-Z][A-Z0-9_]+\b/.test(head)) for (const s of resolve(head.match(/^[A-Z][A-Z0-9_]+/)![0])) ownOptions.add(s);
    let i = head.indexOf("[");
    while (i >= 0) {
      const list = bracketed(code, at + i);
      for (const s of resolve(list)) ownOptions.add(s);
      const next = head.indexOf("[", i + Math.max(list.length, 1));
      i = next;
    }
  }
}
const options = [...ownOptions].filter((s) => s.trim() && s.length <= 200);

describe("Boss Man's own card options and the hand-over rule (DR-078)", () => {
  it("finds the option lists (the scan is not empty)", () => {
    // Known options from system, deploy, merge and to-do cards: if the scan stops finding them it proves nothing.
    for (const known of ["Got it", "Approve", SCREEN_DIFFERENT_OPTION]) expect(options).toContain(known);
    expect(options.length).toBeGreaterThan(40);
  });

  it("no option but R19's promises a hand-over, so none is refused when raised", () => {
    const hits = options.filter((o) => promisedHandOver(o)).sort();
    expect(hits).toEqual([SCREEN_DIFFERENT_OPTION]);
    expect(handOverRefusal(options, { attachOptions: [SCREEN_DIFFERENT_OPTION] })).toBeNull();
  });
});
