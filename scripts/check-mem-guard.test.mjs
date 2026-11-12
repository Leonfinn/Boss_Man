import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overMessage, parents, processBytes, tree } from "./check-mem-guard.mjs";

const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-mem-guard.mjs");
const hasProc = existsSync("/proc/self/smaps_rollup") || existsSync("/proc/self/statm");

test("parents reads the parent pid even when the command name holds spaces and brackets", () => {
  const files = { "/proc/10/stat": "10 (a) b (c)) S 4 1 1 0", "/proc/11/stat": "11 (node) S 10 1 1 0" };
  const map = parents((p) => files[p], () => ["10", "11", "self"]);
  assert.equal(map.get(10), 4);
  assert.equal(map.get(11), 10);
});

test("tree walks down from the root and leaves out the skipped pid", () => {
  const ppids = new Map([[2, 1], [3, 2], [4, 2], [5, 4], [9, 1]]);
  assert.deepEqual(tree(2, ppids, 4).sort(), [2, 3]);
});

test("processBytes prefers PSS and falls back to resident size", () => {
  assert.equal(processBytes(1, (p) => (p.endsWith("smaps_rollup") ? "Rss: 9 kB\nPss:        100 kB\n" : undefined)), 100 * 1024);
  assert.equal(processBytes(1, (p) => (p.endsWith("statm") ? "50 7 1 1 0 1 0" : undefined)), 7 * 4096);
});

test("the message says what happened, the ceiling and what to do", () => {
  const m = overMessage(7168, 6144);
  assert.match(m, /STOPPED/);
  assert.match(m, /7\.0 GB/);
  assert.match(m, /6\.0 GB ceiling \(BOSSMAN_CHECK_MEMORY_MB\)/);
});

// A real process tree: a parent that starts a child holding ~300 MB, watched with a 100 MB ceiling.
const holder = `const b = Buffer.alloc(300 * 1024 * 1024, 1); process.stdout.write("ready\\n"); setInterval(() => { b[0]++; }, 100);`;

function run(ceilingMb, peakFile) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", holder], { stdio: ["ignore", "pipe", "inherit"] });
    let guardOut = "";
    let started = false;
    child.stdout.on("data", () => {
      if (started) return;
      started = true;
      const g = spawn(process.execPath, [guard, String(child.pid), String(ceilingMb), peakFile], { stdio: ["ignore", "inherit", "pipe"] });
      g.stderr.on("data", (d) => (guardOut += d));
      const deadline = setTimeout(() => { g.kill(); child.kill("SIGKILL"); }, 60000);
      g.on("exit", (code) => {
        clearTimeout(deadline);
        child.kill("SIGKILL");
        resolve({ code, guardOut });
      });
    });
  });
}

test("a process over the ceiling is killed with a plain message and exit 3", { skip: !hasProc }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memguard-"));
  try {
    const r = await run(100, path.join(dir, "peak"));
    assert.equal(r.code, 3, r.guardOut);
    assert.match(r.guardOut, /STOPPED: this check used about/);
    assert.ok(Number(readFileSync(path.join(dir, "peak"), "utf8")) > 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a process under the ceiling is left alone, and the peak is still recorded", { skip: !hasProc }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memguard-"));
  try {
    const peakFile = path.join(dir, "peak");
    const child = spawn(process.execPath, ["-e", holder], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => child.stdout.once("data", resolve));
    const g = spawn(process.execPath, [guard, String(child.pid), "100000", peakFile], { stdio: "ignore" });
    // Wait for the event, not a fixed time: the peak file appearing means the guard sampled the 300 MB holder.
    const deadline = Date.now() + 60000;
    while (!existsSync(peakFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const alive = (() => { try { process.kill(child.pid, 0); return true; } catch { return false; } })();
    g.kill();
    child.kill("SIGKILL");
    assert.ok(alive, "the guard must not kill a process under its ceiling");
    assert.ok(Number(readFileSync(peakFile, "utf8")) >= 250);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
