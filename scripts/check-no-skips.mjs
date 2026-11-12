#!/usr/bin/env node
// Fails when a vitest JSON report shows a skipped or todo test, or no passed test at all.
// The merge check runs the web suite with this (BOS-1071), the same rule CI's web-browser job applies:
// tests that need the built web app or a real browser skip quietly where those are missing, and a skip
// at the gate would let a layout break through to GitHub CI. Usage: check-no-skips.mjs <report.json>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @returns {{ passed: number, skipped: string[] }} */
export function summarise(report) {
  const skipped = [];
  for (const f of report.testResults ?? []) {
    for (const t of f.assertionResults ?? []) {
      if (t.status !== "passed" && t.status !== "failed") skipped.push(`${f.name}: ${t.fullName}`);
    }
    // A file that registered no test at all because its describe was skipped shows up as pending suites only.
  }
  return { passed: report.numPassedTests ?? 0, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: check-no-skips.mjs <vitest-report.json>"); process.exit(2); }
  let report;
  try { report = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
    console.error(`check-no-skips: cannot read ${file}: ${e.message}`); process.exit(1);
  }
  const { passed, skipped } = summarise(report);
  console.log(`check-no-skips: ${passed} passed, ${skipped.length} skipped`);
  if (skipped.length || passed === 0) {
    console.error("check-no-skips: these tests skipped. At the merge gate a missing web build, browser or Vite must fail, not skip:");
    console.error(skipped.join("\n"));
    process.exit(1);
  }
}
