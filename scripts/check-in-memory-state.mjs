// Fails when apps/server/src declares in-memory state (an empty `new Map()` / `new Set()` at
// module or service-factory level, i.e. indented at most 2 spaces) without a note on the same
// line or within the 3 lines above containing `shortcut:` or `lost on restart`, or `not state:` for a
// local in a top-level function (its body sits at the same 2-space indent as a factory's).
// Why: a restart, or a second server during a blue/green swap, must not silently lose or fork
// state. See "Rules for server code" in docs/10-migrations.md.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const decl = /^ {0,2}(?:export )?(?:const|let|var)\s+\w+(?:\s*:[^=]+)?\s*=\s*new (?:Map|Set|WeakMap|WeakSet)(?:<.*>)?\(\)/;
const noted = /shortcut:|lost on restart|not state:/;

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));

export function findUnannotated(file, text) {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => (decl.test(line) && !lines.slice(Math.max(0, i - 3), i + 1).some((l) => noted.test(l)) ? [`${file}:${i + 1}: ${line.trim()}`] : []));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bad = walk(process.argv[2] ?? "apps/server/src").flatMap((f) => findUnannotated(f, readFileSync(f, "utf8")));
  if (bad.length) {
    console.error(`In-memory state without a "// shortcut: <limit>, <when to upgrade>" (or "lost on restart, harmless because ...") note:\n${bad.join("\n")}`);
    process.exit(1);
  }
}
