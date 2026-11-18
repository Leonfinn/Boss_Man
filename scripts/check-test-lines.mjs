#!/usr/bin/env node
// Ratchet for the four test-line shapes behind most GitHub-only flakes (BOS-1720 sweep, fix 6; CLAUDE.md "Writing tests"):
//   bare-sleep       a fixed sleep (`await new Promise(r => setTimeout(r, 300))`, `sleep(500)`) outside a polling loop
//   elapsed-limit    `expect(elapsed).toBeLessThan(n)`: a wall-clock limit tuned to one machine
//   fresh-date-sum   a sum or difference on a fresh `Date.now()` inside an `expect` (the clock moved between the two reads)
//   fixed-length-read  `readFileSync(other).slice(0, N)`: a fixed number of characters of another file's text
// scripts/test-lines-baseline.json holds today's count per rule and file. A file may not have MORE hits of a rule than its
// baseline (existing lines stay until touched); a lower count passes with a hint to run `--update`, so two branches that each
// remove a hit don't conflict on a failing check. Usage: check-test-lines.mjs [--update] [--root <dir>]
//
// Allowed, never counted:
//   - a sleep inside a polling loop (a `while`/`for` on the same line or within 3 lines above) or inside a helper named
//     waitFor, waitUntil, poll*, eventually, until*, retry* (the helper itself is the one place that may sleep);
//   - an elapsed limit on a line that mentions LIMIT_MS or baseline (the two documented forms in CLAUDE.md);
//   - any line, or the line below a comment, carrying `test-lines-ok: <why>`.
// Prefer: `vi.waitFor`, `expect.poll`, the file's own waitFor helper, `vi.useFakeTimers()` for time, one `now` constant read once.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOC = "CLAUDE.md, section \"Writing tests: they must pass on GitHub's runners too\"";

const LOOP = /\b(?:while|for)\s*\(|\bdo\s*\{/;
const POLL_HELPER = /(?:function\s+|const\s+|let\s+)(?:waitFor|waitUntil|poll\w*|eventually|until\w*|retry\w*)\b/i;
// A literal, non-zero delay only: `setTimeout(r, 0)` just yields to the event loop, and `setTimeout(r, ms)` is the sleep helper's own definition (its callers are caught).
const SLEEP = /new Promise\(\s*\(?\s*\w+\s*\)?\s*=>\s*(?:setTimeout|globalThis\.setTimeout)\(\s*\w+\s*,\s*[1-9][\d_]*\s*\)\s*\)|\b(?:await\s+)?(?:sleep|delay|wait|pause|nap)\(\s*[1-9][\d_]*\s*\)/;

export const RULES = {
  "bare-sleep": {
    fix: "wait for the event instead (vi.waitFor, expect.poll, or a waitFor helper with a deadline), or use vi.useFakeTimers()",
    test: (line, ctx) => SLEEP.test(line) && !LOOP.test(line) && !ctx.above(3).some((l) => LOOP.test(l)) && !ctx.above(8).some((l) => POLL_HELPER.test(l)) && !POLL_HELPER.test(line),
  },
  "elapsed-limit": {
    fix: "time the work against a baseline run in turn on the same machine, or give GitHub its own LIMIT_MS and say what it still catches",
    test: (line) =>
      !/LIMIT_MS|baseline/i.test(line) &&
      (/expect\(\s*[\w.]*(?:elapsed|duration|took|spent|latency|millis)\w*\s*\)\s*\.toBeLessThan(?:OrEqual)?\(/i.test(line) ||
        /expect\(\s*(?:Date\.now|performance\.now)\(\)\s*-[^)]*\)\s*\.toBeLessThan(?:OrEqual)?\(/.test(line)),
  },
  "fresh-date-sum": {
    fix: "read Date.now() once into a constant and compare to that, or use vi.useFakeTimers() and vi.setSystemTime()",
    test: (line) => /\bexpect\(/.test(line) && /Date\.now\(\)\s*[-+]|[-+]\s*Date\.now\(\)/.test(line) && !/LIMIT_MS|baseline/i.test(line),
  },
  "fixed-length-read": {
    fix: "read the whole file, or match the one line or marker you mean, so the test doesn't depend on where the text happens to fall",
    test: (line) => /\b(?:readFileSync|readFile)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)(?:\.toString\([^)]*\))?\.(?:slice|substring|substr)\(\s*-?\d/.test(line),
  },
};

const TEST_FILE = /(?:^|\/)test\/.*\.(?:ts|tsx|mjs|js)$|\.(?:test|spec)\.(?:ts|tsx|mjs|js)$/;
// This lint's own tests quote the patterns on purpose.
const SKIP_FILE = /^scripts\/check-test-lines\.test\.mjs$/;

/** @returns {{ rule: string, line: number, text: string }[]} */
export function scanText(text) {
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((text, i) => {
    if (/test-lines-ok:/.test(text) || (i > 0 && /test-lines-ok:/.test(lines[i - 1]))) return;
    const ctx = { above: (n) => lines.slice(Math.max(0, i - n), i) };
    for (const [rule, r] of Object.entries(RULES)) {
      if (r.test(text, ctx)) { hits.push({ rule, line: i + 1, text: text.trim() }); break; }
    }
  });
  return hits;
}

export function scanRepo(root) {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
  /** @type {Record<string, Record<string, { line: number, text: string }[]>>} rule -> file -> hits */
  const found = {};
  for (const rel of listed) {
    if (!TEST_FILE.test(rel) || SKIP_FILE.test(rel) || /(^|\/)node_modules\//.test(rel) || !existsSync(path.join(root, rel))) continue;
    for (const h of scanText(readFileSync(path.join(root, rel), "utf8"))) ((found[h.rule] ??= {})[rel] ??= []).push(h);
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
