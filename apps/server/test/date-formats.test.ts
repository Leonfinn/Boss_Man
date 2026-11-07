// BOS-652: one cached date formatter for the server and shared code.
//
// Building an Intl.DateTimeFormat costs ~70-90 µs and ~24 KiB of native memory the GC doesn't see,
// so a `new Intl.` inside a function body runs that cost on every call and any per-row use is a
// server freeze waiting to happen (BOS-643, BOS-649). Formatters must come from the shared
// cached helper (packages/shared/src/dates.ts) and be cached at module level, not rebuilt per call.
//
// This test scans the source, so it fails on a new per-call `new Intl.` even when no test exercises
// it. A module-level `const fmt = new Intl.DateTimeFormat(...)` is allowed: it is built once.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIRS = ["apps/server/src", "packages/shared/src"].map((d) => join(ROOT, d));

/** The one place a formatter is built, and the module-level caches that are allowed to. */
const ALLOWED = new Set(["packages/shared/src/dates.ts", "packages/shared/src/roadmap.ts"]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? tsFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Every `new Intl.` in `text` that sits inside a `{ ... }` block (a function or method body, or a
 * callback). A formatter built at module level is outside every block and is not reported.
 * Comments are dropped first so documentation can mention the pattern.
 */
export function perCallIntlSites(text: string): Array<{ line: number; code: string }> {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length)).replace(/\/\/[^\n]*/g, "");
  const sites: Array<{ line: number; code: string }> = [];
  let depth = 0;
  let line = 1;
  const re = /[{}]|new\s+Intl\./g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const tok = m[0];
    if (tok === "{") depth++;
    else if (tok === "}") depth = Math.max(0, depth - 1);
    else if (depth > 0) {
      line = code.slice(0, m.index).split("\n").length;
      sites.push({ line, code: code.slice(m.index, code.indexOf("\n", m.index) === -1 ? undefined : code.indexOf("\n", m.index)).trim() });
    }
  }
  return sites;
}

describe("no per-call Intl formatters (BOS-652)", () => {
  it("scans the server and shared source (the scan itself works)", () => {
    const files = DIRS.flatMap(tsFiles);
    expect(files.length).toBeGreaterThan(50);
  });

  it("builds no Intl formatter inside a function body; use dateFormat/formatDate/isTimeZone", () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of tsFiles(dir)) {
        const rel = relative(ROOT, file).split("\\").join("/");
        if (ALLOWED.has(rel)) continue;
        for (const site of perCallIntlSites(readFileSync(file, "utf8"))) offenders.push(`${rel}:${site.line}  ${site.code}`);
      }
    }
    expect(offenders, `Build the formatter once (module level) or use @boss-man/shared's dateFormat:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("catches a per-call formatter added to a function body", () => {
    const sample = [
      "const top = new Intl.DateTimeFormat('en-GB');",
      "export function when(d: Date) {",
      "  // a new Intl.DateTimeFormat in a comment is fine",
      "  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC' }).format(d);",
      "}",
      "const later = (d: Date) => `${new Intl.NumberFormat('en-GB').format(1)} ${d}`;",
    ].join("\n");
    const sites = perCallIntlSites(sample);
    expect(sites.map((s) => s.line)).toEqual([4, 6]);
  });
});
