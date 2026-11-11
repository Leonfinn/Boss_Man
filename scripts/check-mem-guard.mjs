// Per-check memory ceiling (BOS-1165). A runner has one Docker memory limit for everything in it; nothing limited a single check,
// so one runaway check could take all of it and the kernel would OOM-kill unrelated work. A cgroup sub-limit needs a writable
// cgroup, which the runner (non-root, CapDrop ALL, cgroup tree owned by root) does not have, and a heap flag only caps node's own
// heap. So this watches instead: usage: node check-mem-guard.mjs <root pid> <ceiling MB> [peak file]
// Every second or two it adds up the memory (PSS where /proc allows it, else RSS) of the root's process tree, not counting
// itself. Over the ceiling it prints a plain message, kills that tree and exits 3. Ceiling 0 only measures. The peak is written to
// the peak file (a number of MB) so check-all.sh can report it at the end. No /proc (macOS): does nothing, exits 0.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const MB = 1024 * 1024;

const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

/** Parent pid of every process, from /proc/<pid>/stat (the name field can hold spaces and brackets, so parse after the last ")"). */
export function parents(readFile = read, list = () => readdirSync("/proc")) {
  const map = new Map();
  for (const name of list()) {
    if (!/^\d+$/.test(name)) continue;
    const s = readFile(`/proc/${name}/stat`);
    if (!s) continue;
    const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
    map.set(Number(name), Number(rest[1]));
  }
  return map;
}

/** root and everything below it, not counting `skip`. */
export function tree(root, ppids, skip) {
  const out = [];
  const kids = new Map();
  for (const [pid, pp] of ppids) kids.set(pp, [...(kids.get(pp) ?? []), pid]);
  const todo = [root];
  while (todo.length) {
    const p = todo.pop();
    if (p !== skip) out.push(p);
    for (const k of kids.get(p) ?? []) if (k !== skip) todo.push(k);
  }
  return out;
}

/** Bytes one process really holds: PSS (shared pages split fairly) if /proc shows it, else resident size. */
export function processBytes(pid, readFile = read) {
  const smaps = readFile(`/proc/${pid}/smaps_rollup`);
  const pss = smaps && /^Pss:\s+(\d+) kB/m.exec(smaps);
  if (pss) return Number(pss[1]) * 1024;
  const statm = readFile(`/proc/${pid}/statm`);
  if (statm) return Number(statm.split(" ")[1]) * 4096;
  return 0;
}

export function treeBytes(root, skip, readFile = read, list) {
  return tree(root, parents(readFile, list), skip).reduce((sum, pid) => sum + processBytes(pid, readFile), 0);
}

export const overMessage = (usedMb, ceilingMb) =>
  `check-all: STOPPED: this check used about ${(usedMb / 1024).toFixed(1)} GB of memory, over its ${(ceilingMb / 1024).toFixed(1)} GB ceiling (BOSSMAN_CHECK_MEMORY_MB), so it was ended before it could use up the runner's memory and stop other work. ` +
  `The step that was running when this line appeared is the one that grew. Fix that step; set BOSSMAN_CHECK_MEMORY_MB to a larger number only if it really needs more (0 turns the ceiling off).`;

async function main() {
  const [rootArg, ceilingArg, peakFile] = process.argv.slice(2);
  const root = Number(rootArg);
  const ceilingMb = Number(ceilingArg);
  if (!Number.isInteger(root) || root < 1 || !Number.isFinite(ceilingMb) || ceilingMb < 0) {
    console.error("usage: check-mem-guard.mjs <root pid> <ceiling MB, 0 = measure only> [peak file]");
    process.exit(2);
  }
  if (!existsSync("/proc/self/stat")) process.exit(0);
  let peak = 0;
  let written = 0;
  for (;;) {
    if (!existsSync(`/proc/${root}`)) return;
    const used = treeBytes(root, process.pid);
    if (used > peak) {
      peak = used;
      if (peakFile && peak - written >= 5 * MB) {
        written = peak;
        try {
          writeFileSync(peakFile, String(Math.round(peak / MB)));
        } catch {
          /* best effort */
        }
      }
    }
    if (ceilingMb > 0 && used > ceilingMb * MB) {
      if (peakFile) {
        try {
          writeFileSync(peakFile, String(Math.round(peak / MB)));
        } catch {
          /* best effort */
        }
      }
      console.error(overMessage(Math.round(used / MB), ceilingMb));
      // Everything below the root, not the root itself: it then sees its step fail, prints the step line and exits non-zero.
      for (const pid of tree(root, parents(), process.pid).filter((p) => p !== root)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      process.exit(3);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
