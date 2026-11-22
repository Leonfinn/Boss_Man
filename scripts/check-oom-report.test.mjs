import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryFacts, reportLine } from "./check-oom-report.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-oom-report.mjs");
const run = (dir, ...args) => execFileSync("node", [script, ...args], { env: { ...process.env, BOSSMAN_CGROUP_DIR: dir }, encoding: "utf8" }).trim();

test("a made-up v2 cgroup whose oom_kill rises gives the out-of-memory line with the limit and the count", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oom-v2-"));
  try {
    writeFileSync(path.join(dir, "memory.max"), `${7 * 1024 ** 3}\n`);
    writeFileSync(path.join(dir, "memory.events"), "low 0\nhigh 0\nmax 0\noom 0\noom_kill 3\n");
    const start = run(dir, "start");
    assert.equal(start, "3");
    writeFileSync(path.join(dir, "memory.events"), "low 0\nhigh 0\nmax 0\noom 2\noom_kill 5\n");
    const line = run(dir, "report", start);
    assert.match(line, /ran out of memory/);
    assert.match(line, /killed 2 processes/);
    assert.match(line, /oom_kill 3 to 5/);
    assert.match(line, /memory limit 7\.0 GB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a count that did not rise says so without the words out of memory", () => {
  const line = reportLine({ limit: 2 * 1024 ** 3, kills: 4 }, "4");
  assert.match(line, /limit 2\.0 GB/);
  assert.match(line, /: 0$/);
  assert.doesNotMatch(line, /out of memory/i);
});

test("a v1 layout is read, and no limit shows as such", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oom-v1-"));
  try {
    mkdirSync(path.join(dir, "memory"));
    writeFileSync(path.join(dir, "memory", "memory.limit_in_bytes"), "9223372036854771712\n");
    writeFileSync(path.join(dir, "memory", "memory.oom_control"), "oom_kill_disable 0\nunder_oom 0\noom_kill 1\n");
    assert.deepEqual(memoryFacts(dir), { limit: null, kills: 1 });
    assert.match(reportLine(memoryFacts(dir), "0"), /killed 1 process for lack/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing or unreadable cgroup files give unknown, and the script still exits 0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oom-none-"));
  try {
    assert.equal(run(dir, "start"), "unknown");
    const line = run(dir, "report", "unknown");
    assert.match(line, /limit unknown/);
    assert.match(line, /oom_kill\) during this check: unknown/);
    assert.doesNotMatch(line, /out of memory/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
