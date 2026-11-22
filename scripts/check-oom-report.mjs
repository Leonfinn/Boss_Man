// What the machine's memory limit and out-of-memory kill count were during a check (BOS-2218).
// usage: node check-oom-report.mjs start          prints the kill count now (a number, or "unknown") to keep
//        node check-oom-report.mjs report <start>  prints one log line: the limit, the kills since <start>
// A test process that the kernel kills for lack of memory dies with "Worker exited unexpectedly with signal SIGKILL", which
// says nothing about why. The cgroup's own counter does: memory.events "oom_kill" (cgroup v2) or memory.oom_control (v1).
// Works on any host: when the files are missing or unreadable it says "unknown", never fails, and always exits 0.
// BOSSMAN_CGROUP_DIR points at another folder (the tests use a made-up one); it holds the v2 files, or a "memory" folder with the v1 ones.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

const count = (text) => {
  const m = /^oom_kill (\d+)$/m.exec(text ?? "");
  return m ? Number(m[1]) : undefined;
};

/** { limit: bytes | null (no limit) | undefined (unknown), kills: number | undefined } from the cgroup files under `dir`. */
export function memoryFacts(dir = process.env.BOSSMAN_CGROUP_DIR || "/sys/fs/cgroup", readFile = read) {
  const lim = (s) => {
    if (s === undefined) return undefined;
    const t = s.trim();
    if (t === "max") return null;
    if (!/^\d+$/.test(t)) return undefined;
    // v1 shows "no limit" as a huge number.
    return Number(t) >= 2 ** 60 ? null : Number(t);
  };
  const v2 = { limit: lim(readFile(path.join(dir, "memory.max"))), kills: count(readFile(path.join(dir, "memory.events"))) };
  if (v2.limit !== undefined || v2.kills !== undefined) return v2;
  return { limit: lim(readFile(path.join(dir, "memory", "memory.limit_in_bytes"))), kills: count(readFile(path.join(dir, "memory", "memory.oom_control"))) };
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * The log line. It says "out of memory" only when the count rose, so a clean run is never read as one;
 * `start` is the count `start` printed ("unknown" or a number).
 */
export function reportLine(facts, start) {
  const limit = facts.limit === undefined ? "unknown" : facts.limit === null ? "no limit" : gb(facts.limit);
  const first = /^\d+$/.test(String(start ?? "")) ? Number(start) : undefined;
  if (facts.kills === undefined || first === undefined) return `check-all: memory: limit ${limit}, memory-limit kills (oom_kill) during this check: unknown (the machine's memory counters could not be read)`;
  const n = Math.max(0, facts.kills - first);
  if (n === 0) return `check-all: memory: limit ${limit}, memory-limit kills (oom_kill) during this check: 0`;
  return `check-all: ran out of memory: the machine killed ${n} process${n === 1 ? "" : "es"} for lack of memory during this check (oom_kill ${first} to ${facts.kills}); memory limit ${limit}. A "Worker exited unexpectedly with signal SIGKILL" above is this, not a fault in the code.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, start] = process.argv.slice(2);
  const facts = memoryFacts();
  if (mode === "start") console.log(facts.kills === undefined ? "unknown" : String(facts.kills));
  else if (mode === "report") console.log(reportLine(facts, start));
  else console.error("usage: check-oom-report.mjs start | report <start>");
}
