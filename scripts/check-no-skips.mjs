#!/usr/bin/env node
// Fails when a test skipped at the gate and its file has no entry, with a reason, on its package's skip list; also when no test passed.
// The merge check runs every package's suite with this (BOS-1071 for web, BOS-1729 for all): tests that need a build, a browser, a
// sandbox or a real service skip quietly where those are missing, and a skip nobody listed is how a layout or sandbox break got through
// to GitHub CI. A list is a text file, one `path | reason` per line (path relative to the package folder, `#` starts a comment).
// A listed file may skip; an unlisted one may not. A listed file that no longer skips is fine (the same list serves hosts that skip and
// hosts that don't). A list line with no reason fails.
// Usage:
//   check-no-skips.mjs <vitest-report.json> [--allow <list>] [--root <package folder>]
//   check-no-skips.mjs --junit <node-test-report.xml> --file <path> [--allow <list>] [--root <folder>]   (one node:test file's report)
// With no --allow list, every skip fails (the web package's rule before the lists existed).
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Parses a skip list. @returns {{ allowed: Map<string, string>, problems: string[] }} */
export function parseAllowList(text) {
  const allowed = new Map();
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const bar = line.indexOf("|");
    const file = (bar < 0 ? line : line.slice(0, bar)).trim();
    const reason = bar < 0 ? "" : line.slice(bar + 1).trim();
    if (!reason) problems.push(`line ${i + 1}: "${file}" has no reason after "|"`);
    else allowed.set(file.replace(/\\/g, "/"), reason);
  });
  return { allowed, problems };
}

const rel = (name, root) => {
  const r = path.isAbsolute(name) ? path.relative(root, name) : name;
  return r.replace(/\\/g, "/");
};

/** @returns {{ passed: number, skipped: string[], unlisted: string[] }} skipped: every skip; unlisted: those whose file is not allowed */
export function summarise(report, opts = {}) {
  const root = opts.root ?? process.cwd();
  const allowed = opts.allowed ?? new Map();
  const skipped = [];
  const unlisted = [];
  for (const f of report.testResults ?? []) {
    for (const t of f.assertionResults ?? []) {
      if (t.status !== "passed" && t.status !== "failed") {
        skipped.push(`${f.name}: ${t.fullName}`);
        if (!allowed.has(rel(f.name, root))) unlisted.push(`${rel(f.name, root)}: ${t.fullName}`);
      }
    }
    // A file that registered no test at all because its describe was skipped shows up as pending suites only.
  }
  return { passed: report.numPassedTests ?? 0, skipped, unlisted };
}

/** One node:test file's junit report: the skipped count sits in a trailing comment. */
export function junitSkips(xml, file) {
  const n = Number(/<!-- skipped (\d+) -->/.exec(xml)?.[1] ?? 0) + Number(/<!-- todo (\d+) -->/.exec(xml)?.[1] ?? 0);
  return n > 0 ? [`${file}: ${n} skipped`] : [];
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const junit = arg("--junit");
  const file = junit ? undefined : process.argv[2];
  if (!junit && !file) { console.error("usage: check-no-skips.mjs <vitest-report.json> [--allow <list>] [--root <dir>] | --junit <xml> --file <path>"); process.exit(2); }
  const root = path.resolve(arg("--root") ?? process.cwd());
  let allowed = new Map();
  const listFile = arg("--allow");
  if (listFile) {
    let text;
    try { text = readFileSync(listFile, "utf8"); } catch (e) { console.error(`check-no-skips: cannot read skip list ${listFile}: ${e.message}`); process.exit(1); }
    const parsed = parseAllowList(text);
    if (parsed.problems.length) { console.error(`check-no-skips: skip list ${listFile} is invalid:\n${parsed.problems.join("\n")}`); process.exit(1); }
    allowed = parsed.allowed;
  }
  if (junit) {
    let xml;
    try { xml = readFileSync(junit, "utf8"); } catch (e) { console.error(`check-no-skips: cannot read ${junit}: ${e.message}`); process.exit(1); }
    const name = rel(arg("--file") ?? "", root);
    const skips = junitSkips(xml, name);
    if (skips.length && !allowed.has(name)) {
      console.error(`check-no-skips: ${skips[0]}, and the file is not on the skip list${listFile ? ` ${listFile}` : ""}. Fix the cause, or add "${name} | <reason>" to the list.`);
      process.exit(1);
    }
    process.exit(0);
  }
  let report;
  try { report = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
    console.error(`check-no-skips: cannot read ${file}: ${e.message}`); process.exit(1);
  }
  const { passed, skipped, unlisted } = summarise(report, { root, allowed });
  const failing = listFile ? unlisted : skipped;
  console.log(`check-no-skips: ${passed} passed, ${skipped.length} skipped${listFile ? `, ${skipped.length - unlisted.length} of them on the skip list` : ""}`);
  if (failing.length || passed === 0) {
    if (failing.length) {
      console.error(listFile
        ? `check-no-skips: these tests skipped and their file is not on the skip list ${listFile}. A test that skips quietly here may run, and fail, on GitHub. Fix what makes it skip, or list the file with a reason ("path | reason"):`
        : "check-no-skips: these tests skipped. At the merge gate a missing web build, browser or Vite must fail, not skip:");
      console.error(failing.join("\n"));
    } else console.error("check-no-skips: no test passed");
    process.exit(1);
  }
}
