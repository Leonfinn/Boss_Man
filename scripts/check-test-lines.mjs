#!/usr/bin/env node
// Ratchet for the five test-line shapes behind most GitHub-only flakes (BOS-1720 sweep, fix 6; CLAUDE.md "Writing tests"):
//   bare-sleep       a fixed sleep (`await new Promise(r => setTimeout(r, 300))`, `sleep(500))` outside a polling loop
//   elapsed-limit    `expect(elapsed).toBeLessThan(n)`: a wall-clock limit tuned to one machine
//   fresh-date-sum   a sum or difference on a fresh `Date.now()` inside an `expect` (the clock moved between the two reads)
//   fixed-length-read  `readFileSync(other).slice(0, N)`: a fixed number of characters of another file's text
//   hidden-stderr    `2>/dev/null`, `2> /dev/null`, `&>/dev/null`, `>/dev/null 2>&1`, `2>&-` on a test step (BOS-2794):
//                    matched on the raw line, since the redirect usually sits inside a string passed to execSync/spawn
// scripts/test-lines-baseline.json holds today's count per rule and file. A file may not have MORE hits of a rule than its
// baseline (existing lines stay until touched); a lower count passes with a hint to run `--update`, so two branches that each
// remove a hit don't conflict on a failing check. Usage: check-test-lines.mjs [--update] [--root <dir>]
//
// The scan works on code, not on lines of text (BOS-1758): comments and the insides of strings are blanked first, so a word in a
// comment (`baseline`, `LIMIT_MS`, `for (`) switches nothing off, and a statement that prettier wrapped over several lines is
// matched as one. Hits are reported on the line where the statement starts.
//
// Also counted: a sleep with a variable delay (`sleep(DELAY)`, `setTimeout(r, DELAY)`, unless the name is a parameter of the
// helper being defined), `function (r) { setTimeout(r, n) }`, an elapsed limit on a difference or a timing name
// (`expect(t1 - t0)`, `expect(ms)`), `new Date().getTime() - n` in an expect, and a read file sliced to a fixed length in a
// later statement (`const t = readFileSync(f); ... t.slice(0, 200)`) or `(await readFile(p)).slice(0, n)`.
//
// Allowed, never counted:
//   - a sleep inside a polling loop (a `while`, `do` or counting `for (;;)` on the same line or within 3 lines above; a `for...of`
//     or `for...in` is not a poll) or inside a helper named waitFor, waitUntil, poll*, eventually, until*, retry* (the helper
//     itself is the one place that may sleep);
//   - an elapsed limit in a statement whose code mentions LIMIT_MS or baseline (the two documented forms in CLAUDE.md);
//   - a statement with `test-lines-ok: <why>` in a comment on its line or the line above.
// Prefer: `vi.waitFor`, `expect.poll`, the file's own waitFor helper, `vi.useFakeTimers()` for time, one `now` constant read once.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOC = "CLAUDE.md, section \"Writing tests: they must pass on GitHub's runners too\"";

// A `for` that counts or spins is a poll; `for (x of xs)` / `for (k in o)` is not.
const LOOP = /\bwhile\s*\(|\bdo\s*\{|\bfor\s*\((?![^)]*\b(?:of|in)\b)/;
const POLL_HELPER = /(?:function\s+|const\s+|let\s+)(?:waitFor|waitUntil|poll\w*|eventually|until\w*|retry\w*)\b/i;

export const RULES = {
  "bare-sleep": { fix: "wait for the event instead (vi.waitFor, expect.poll, or a waitFor helper with a deadline), or use vi.useFakeTimers()" },
  "elapsed-limit": { fix: "time the work against a baseline run in turn on the same machine, or give GitHub its own LIMIT_MS and say what it still catches" },
  "fresh-date-sum": { fix: "read Date.now() once into a constant and compare to that, or use vi.useFakeTimers() and vi.setSystemTime()" },
  "fixed-length-read": { fix: "read the whole file, or match the one line or marker you mean, so the test doesn't depend on where the text happens to fall" },
  "hidden-stderr": { fix: "let the error show, or capture it and assert on it; if the step is allowed to fail, say why with `test-lines-ok: <why>`" },
};

// Matched on the raw line: in a .ts test the redirect is inside a string passed to execSync/spawn, which sanitize() blanks.
const HIDDEN_STDERR = /(?:2>\s*\/dev\/null|&>\s*\/dev\/null|>\s*\/dev\/null\s+2>&1|2>&-)/;

// ---- code view: comments and string insides blanked, newlines kept ----
/** @returns {{ code: string, markers: Set<number> }} markers = 0-based lines covered by a comment carrying test-lines-ok */
export function sanitize(src, { shell = false } = {}) {
  let out = "";
  const markers = new Set();
  let line = 0, recent = "", i = 0;
  const n = src.length;
  const blank = (ch) => { out += ch === "\n" ? "\n" : " "; if (ch === "\n") line++; };
  const code = (ch) => { out += ch; if (ch === "\n") line++; else if (!/\s/.test(ch)) recent = (recent + ch).slice(-12); };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (shell && c === "#" && (i === 0 || /[\s;&|(]/.test(src[i - 1]))) {
      let j = src.indexOf("\n", i); if (j < 0) j = n;
      if (/test-lines-ok:/.test(src.slice(i, j))) markers.add(line);
      out += " ".repeat(j - i); i = j; continue;
    }
    if (c === "/" && d === "/") {
      let j = src.indexOf("\n", i); if (j < 0) j = n;
      if (/test-lines-ok:/.test(src.slice(i, j))) markers.add(line);
      out += " ".repeat(j - i); i = j; continue;
    }
    if (c === "/" && d === "*") {
      let j = src.indexOf("*/", i + 2); j = j < 0 ? n : j + 2;
      const cm = src.slice(i, j), has = /test-lines-ok:/.test(cm);
      for (const ch of cm) { if (has) markers.add(line); blank(ch); }
      if (has) markers.add(line);
      i = j; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c; i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") { blank(src[i]); if (i + 1 < n) blank(src[i + 1]); i += 2; continue; }
        if (c !== "`" && src[i] === "\n") break;
        blank(src[i]); i++;
      }
      if (src[i] === c) { out += c; i++; }
      recent = (recent + '"').slice(-12);
      continue;
    }
    if (c === "/" && /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn)$/.test(recent)) {
      // regex literal: copy it as code but blank its body so quotes inside don't open a string
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
      if (src[j] === "/") { out += "/" + " ".repeat(j - i - 1) + "/"; i = j + 1; while (/[a-z]/.test(src[i] ?? "")) { out += " "; i++; } recent = (recent + "/").slice(-12); continue; }
    }
    code(c); i++;
  }
  return { code: out, markers };
}

/** End offset of the statement starting at `start`: a `;`, a closing bracket, or a newline not followed by `.chain`. */
function stmtEnd(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) return i; depth--; }
    else if (c === ";" && depth === 0) return i;
    else if (c === "\n" && depth === 0) { const nx = /^\s*(\S)/.exec(code.slice(i + 1, i + 200)); if (!nx || (nx[1] !== "." && nx[1] !== "?")) return i; }
  }
  return code.length;
}

/** The text inside the parenthesis opened at `open` (code[open] === "("). */
function parenBody(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

const CLOCK = String.raw`(?:Date\.now\(\s*\)|new\s+Date\(\s*\)\s*\.getTime\(\s*\)|performance\.now\(\s*\))`;
const CLOCK_RE = new RegExp(CLOCK);
const FRESH_SUM = new RegExp(String.raw`${CLOCK}\s*[-+]|[-+]\s*${CLOCK}`);
const TIME_NAME = /^(?:[\w.]*(?:[Ee]lapsed|[Dd]uration|[Tt]ook|[Ss]pent|[Ll]atency|[Mm]illis|[Mm]sec)\w*|ms|time|dt|delta|diff|t\d*|\w*Ms)$/;
const TIME_OPERAND = /^(?:t\d*|(?:start|end|begin|before|after|now|finish|stop|tick|then)\w*|\w*(?:Start|End|Time|At|Ms)|[\w.]*(?:elapsed|duration)\w*)$/;
const lastSeg = (s) => s.trim().replace(/\(\s*\)$/, "").split(".").pop();

function isTimingSubject(s) {
  s = s.trim();
  if (TIME_NAME.test(lastSeg(s)) && /^[\w.]+$/.test(s)) return true;
  if (CLOCK_RE.test(s) && /[-]/.test(s)) return true;
  const m = /^(.+?)\s-\s(.+)$/s.exec(s);
  return !!m && [m[1], m[2]].some((side) => CLOCK_RE.test(side) || TIME_OPERAND.test(lastSeg(side)));
}

const BAL = String.raw`(?:[^()]|\((?:[^()]|\([^()]*\))*\))*`;
const SLICE = String.raw`\.(?:slice|substring|substr)\(\s*-?\d`;
const DIRECT_READ = new RegExp(String.raw`(?:await\s+)?[\w.]*\breadFile(?:Sync)?\s*\(${BAL}\)\s*\)?(?:\s*\.toString\([^)]*\))?\s*${SLICE}`, "g");
const READ_DECL = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=/g;
const SLEEP_ARGS = String.raw`(?:\(\s*\w*\s*\)|\w+|function\s*\w*\s*\(\s*\w*\s*\))\s*(?:=>)?\s*\{?\s*(?:return\s+)?(?:globalThis\.|window\.)?setTimeout\(\s*(?:\(\s*\)\s*=>\s*)?\w+(?:\(\s*\))?\s*,\s*([\w$.]+)\s*,?\s*\)\s*;?\s*\}?\s*,?\s*\)`;
const SLEEP_PROMISE = new RegExp(String.raw`new\s+Promise\(\s*${SLEEP_ARGS}`, "g");
// Not a definition (`function pause(ms) {`, `async pause(id) {`): the call must not be followed by a body.
const SLEEP_CALL = /(?<!\b(?:function|async|get|set|static)\s+)\b(?:await\s+)?(?:\w+\.)?(sleep|delay|nap|pause|wait)(?:Ms|Millis)?\(\s*([\w$.]+)\s*\)(?!\s*(?::[^=;{()]*)?\{)/g;

const isLiteral = (a) => /^\d[\d_]*$/.test(a);
const isZero = (a) => /^0[\d_]*$/.test(a);
/** `id` is a parameter of a function defined just above: then the call is the sleep helper itself, whose callers are counted. */
function isParam(code, idx, id) {
  const before = code.slice(Math.max(0, idx - 400), idx);
  const e = id.replace(/[$.]/g, "\\$&");
  return new RegExp(String.raw`(?:\([^()]*\b${e}\b[^()]*\)\s*(?::[^=;{]*)?=>|\b${e}\s*=>|function\s*\w*\s*\([^()]*\b${e}\b)`).test(before);
}

/** The line with its trailing comment removed (unquoted `#` in shell, `//` in JS/TS); the redirect can sit in a string. */
function stripComment(line, shell) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (shell && c === "#" && (i === 0 || /[\s;&|(]/.test(line[i - 1]))) return line.slice(0, i);
    if (!shell && c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/** hidden-stderr, on the raw line so a redirect inside a string is still seen: whole-line comments never count. */
function scanHiddenStderr(text, markers, raw, shell) {
  const out = [];
  for (let l = 0; l < raw.length; l++) {
    if (markers.has(l - 1) || markers.has(l)) continue;
    const line = stripComment(raw[l], shell);
    if (!HIDDEN_STDERR.test(line)) continue;
    if (shell && /^\s*#/.test(raw[l])) continue;
    out.push({ rule: "hidden-stderr", line: l + 1, text: raw[l].trim() });
  }
  return out;
}

/** @returns {{ rule: string, line: number, text: string }[]} */
export function scanText(text, { shell = false } = {}) {
  const { code, markers } = sanitize(text, { shell });
  const raw = text.split("\n"), lines = code.split("\n");
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") starts.push(i + 1);
  const lineOf = (idx) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo; };
  const ruleNames = Object.keys(RULES);
  /** @type {Map<number, string>} 0-based line -> rule, one hit per line (first rule in RULES order wins) */
  const found = new Map();
  const add = (rule, idx, endIdx = idx) => {
    const l = lineOf(idx);
    if (markers.has(l - 1)) return;
    for (let k = l; k <= lineOf(endIdx); k++) if (markers.has(k)) return; // a marker anywhere on the statement's lines

    const prev = found.get(l);
    if (!prev || ruleNames.indexOf(rule) < ruleNames.indexOf(prev)) found.set(l, rule);
  };
  const above = (l, n) => lines.slice(Math.max(0, l - n), l);

  // bare-sleep
  const sleepAt = (idx, delay, endIdx) => {
    if (isZero(delay)) return; // setTimeout(r, 0) only yields to the event loop
    if (!isLiteral(delay) && isParam(code, idx, delay)) return; // the sleep helper's own definition
    const l = lineOf(idx);
    if (LOOP.test(lines[l]) || POLL_HELPER.test(lines[l]) || above(l, 3).some((x) => LOOP.test(x)) || above(l, 8).some((x) => POLL_HELPER.test(x))) return;
    add("bare-sleep", idx, endIdx);
  };
  for (const m of code.matchAll(SLEEP_PROMISE)) sleepAt(m.index, m[1], m.index + m[0].length);
  for (const m of code.matchAll(SLEEP_CALL)) {
    if (m[1] === "wait" && !isLiteral(m[2])) continue; // `wait(promise)` is too common a name to guess at
    sleepAt(m.index, m[2], m.index + m[0].length);
  }

  // elapsed-limit, fresh-date-sum
  for (const m of code.matchAll(/\bexpect(?:\.\w+)*\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const stmt = code.slice(m.index, stmtEnd(code, m.index));
    if (/LIMIT_MS|baseline/i.test(stmt)) continue;
    if (/\.toBeLessThan(?:OrEqual)?\s*\(/.test(stmt) && isTimingSubject(parenBody(code, open))) add("elapsed-limit", m.index, m.index + stmt.length);
    else if (FRESH_SUM.test(stmt)) add("fresh-date-sum", m.index, m.index + stmt.length);
  }

  // fixed-length-read
  for (const m of code.matchAll(DIRECT_READ)) add("fixed-length-read", m.index);
  for (const m of code.matchAll(READ_DECL)) {
    const end = stmtEnd(code, m.index + m[0].length);
    const rhs = code.slice(m.index + m[0].length, end);
    if (!/\breadFile(?:Sync)?\s*\(/.test(rhs) || /\.(?:split|match|matchAll|map|filter)\s*\(|\bJSON\.parse\b|\bparse\w*\(/.test(rhs)) continue;
    // both ends literal: `t.slice(0, 200)`, not `t.slice(0, start)` (a position the test computed)
    const use = new RegExp(String.raw`\b${m[1]}\s*\.(?:toString\([^)]*\)\s*\.)?(?:slice|substring|substr|subarray)\(\s*-?\d[\d_]*\s*(?:,\s*(?:-?\d[\d_]*|[A-Z][A-Z0-9_]+)\s*)?\)`, "g");
    use.lastIndex = end;
    for (const u of code.matchAll(use)) if (u.index >= end) add("fixed-length-read", u.index);
  }

  const onCode = [...found].sort((a, b) => a[0] - b[0]).map(([l, rule]) => ({ rule, line: l + 1, text: raw[l].trim() }));
  // hidden-stderr joins the result; at most one hit per line (a code hit there wins, as in `found`).
  const taken = new Set(onCode.map((h) => h.line));
  return [...onCode, ...scanHiddenStderr(text, markers, raw, shell).filter((h) => !taken.has(h.line))].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

const TEST_FILE = /(?:^|\/)test\/.*\.(?:ts|tsx|mjs|js)$|\.(?:test|spec)\.(?:ts|tsx|mjs|js)$|\.test\.sh$/;
// This lint's own tests quote the patterns on purpose.
const SKIP_FILE = /^scripts\/check-test-lines\.test\.mjs$/;

export function scanRepo(root) {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
  /** @type {Record<string, Record<string, { line: number, text: string }[]>>} rule -> file -> hits */
  const found = {};
  for (const rel of listed) {
    if (!TEST_FILE.test(rel) || SKIP_FILE.test(rel) || /(^|\/)node_modules\//.test(rel) || !existsSync(path.join(root, rel))) continue;
    for (const h of scanText(readFileSync(path.join(root, rel), "utf8"), { shell: rel.endsWith(".test.sh") })) ((found[h.rule] ??= {})[rel] ??= []).push(h);
  }
  return found;
}

export function compare(found, baseline) {
  const failures = [];
  const lower = [];
  for (const [rule, files] of Object.entries(found)) {
    for (const [file, hits] of Object.entries(files)) {
      const allowed = baseline[rule]?.[file] ?? 0;
      if (hits.length > allowed) failures.push({ rule, file, allowed, hits });
    }
  }
  for (const [rule, files] of Object.entries(baseline)) {
    for (const [file, allowed] of Object.entries(files)) {
      const now = found[rule]?.[file]?.length ?? 0;
      if (now < allowed) lower.push({ rule, file, allowed, now });
    }
  }
  return { failures, lower };
}

export function toBaseline(found) {
  const out = {};
  for (const rule of Object.keys(RULES)) {
    const files = Object.entries(found[rule] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
    out[rule] = Object.fromEntries(files.map(([f, h]) => [f, h.length]));
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const ri = args.indexOf("--root");
  const root = ri >= 0 ? path.resolve(args[ri + 1]) : path.resolve(HERE, "..");
  const baselineFile = path.join(root, "scripts", "test-lines-baseline.json");
  const found = scanRepo(root);
  if (update) {
    writeFileSync(baselineFile, JSON.stringify(toBaseline(found), null, 2) + "\n");
    console.log(`check-test-lines: baseline written to ${path.relative(root, baselineFile)}`);
    process.exit(0);
  }
  let baseline = {};
  try { baseline = JSON.parse(readFileSync(baselineFile, "utf8")); } catch (e) {
    console.error(`check-test-lines: cannot read ${baselineFile}: ${e.message}`); process.exit(1);
  }
  const { failures, lower } = compare(found, baseline);
  const total = Object.values(found).reduce((n, f) => n + Object.values(f).reduce((m, h) => m + h.length, 0), 0);
  console.log(`check-test-lines: ${total} flagged test lines (baseline ${Object.values(baseline).reduce((n, f) => n + Object.values(f).reduce((m, c) => m + c, 0), 0)})`);
  for (const f of failures) {
    console.error(`check-test-lines: ${f.file} has ${f.hits.length} ${f.rule} line(s), the baseline allows ${f.allowed}. Fix: ${RULES[f.rule].fix}.`);
    for (const h of f.hits) console.error(`  ${f.file}:${h.line}: ${h.text}`);
  }
  if (failures.length) {
    console.error(`check-test-lines: see ${DOC}. A false hit: add \`// test-lines-ok: <why>\` on or above the line. Never raise the baseline to make this pass.`);
    process.exit(1);
  }
  if (lower.length) console.log(`check-test-lines: ${lower.length} file(s) have fewer hits than the baseline: run \`node scripts/check-test-lines.mjs --update\` and commit it so the count stays down.`);
}
