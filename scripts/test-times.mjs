#!/usr/bin/env node
// Per-file test times for the merge check's result store (BOS-654). Reads the folder the check wrote into
// (BOSSMAN_CHECK_TIMES_DIR): vitest JSON reports named "vitest-<package>.json" and "shell.tsv" (one "<script>\t<seconds>\t<exit>" line per
// shell test). Prints {"vitest":{"<package>":{"<file>":seconds}},"shell":{"<script>":seconds}} with the slowest first.
// Best effort: unreadable or missing input gives empty sections, never an error.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const sortDesc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));

export function summarize(dir) {
  const out = { vitest: {}, shell: {} };
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const m = /^vitest-(.+)\.json$/.exec(n);
    if (!m) continue;
    try {
      const report = JSON.parse(readFileSync(path.join(dir, n), "utf8"));
      const files = {};
      for (const r of report.testResults ?? []) {
        let secs = Number(r.endTime) - Number(r.startTime);
        if (!Number.isFinite(secs)) secs = (r.assertionResults ?? []).reduce((s, a) => s + (Number(a.duration) || 0), 0);
        // Names are absolute; keep them relative to the package so results compare between checkouts.
        const rel = String(r.name).replace(/^.*?\/(apps|packages)\//, "$1/");
        files[rel] = Math.round(secs) / 1000;
      }
      out.vitest[m[1]] = sortDesc(files);
    } catch {}
  }
  try {
    const shell = {};
    for (const line of readFileSync(path.join(dir, "shell.tsv"), "utf8").split("\n")) {
      const [name, secs] = line.split("\t");
      if (name && Number.isFinite(Number(secs))) shell[name] = Number(secs);
    }
    out.shell = sortDesc(shell);
  } catch {}
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.stdout.write(JSON.stringify(summarize(process.argv[2] ?? "")) + "\n");
}
