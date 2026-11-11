// One CPU budget for every part of a check (BOS-674): how many threads one check (or one hand test run) may keep busy.
// Every package's vitest config takes its maxWorkers from checkThreads(), and check-all.sh / check-quick.sh export the
// same number to the native tools: GOMAXPROCS for tsc (TypeScript 7 is a Go binary), RAYON_NUM_THREADS and
// TOKIO_WORKER_THREADS for the web build (Vite 8 bundles with Rolldown, which is Rust).
//
// BOSSMAN_CHECK_THREADS (a whole number >= 1) sets it outright. Otherwise it is this check slot's share of the CPUs the
// container may use (CPU affinity and the cgroup's cpu.max quota, so a Docker --cpus limit counts; no hardcoded core
// counts), capped at DEFAULT_MAX so one check never fills a big host, and never below 1. The slot count is
// BOSSMAN_CHECK_SLOTS, else the number check-all.sh reads from its proof file, else 1. It is also capped by the cgroup's
// free memory (limit minus use, minus reclaimable cache) at about 1.2 GB per worker, split across the slots (BOS-1027);
// with no readable memory limit that cap does not apply.
// Run as a script, it prints the number (for the shell scripts).
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX = 4;
const PROOF = "/var/tmp/bossman-check-pair-passed";

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const whole = (v) => (/^\s*\d{1,4}\s*$/.test(String(v ?? "")) ? Number(v) : undefined);

// CPUs the cgroup quota allows (cgroup v2 cpu.max "<quota> <period>", or v1 cfs files); undefined when unlimited or unknown.
export function cgroupCpus(readFile = read) {
  const v2 = readFile("/sys/fs/cgroup/cpu.max");
  if (v2 !== undefined) {
    const [quota, period] = v2.trim().split(/\s+/);
    const q = Number(quota), p = Number(period);
    return quota !== "max" && q > 0 && p > 0 ? q / p : undefined;
  }
  const q = Number(readFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")), p = Number(readFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
  return q > 0 && p > 0 ? q / p : undefined;
}

// Memory one test worker may need (a worker starts real adapter processes of ~0.7-1.2 GB; BOS-1027).
export const BYTES_PER_WORKER = 1.2 * 1024 ** 3;

// Bytes the cgroup still has free (limit minus in-use, not counting reclaimable page cache); undefined when there is no
// limit or it cannot be read (generic hosts), so the CPU rule alone applies.
export function cgroupFreeMemory(readFile = read) {
  const num = (s) => (s !== undefined && /^\s*\d+\s*$/.test(s) ? Number(s) : undefined);
  let limit = num(readFile("/sys/fs/cgroup/memory.max"));
  let used = num(readFile("/sys/fs/cgroup/memory.current"));
  let stat = readFile("/sys/fs/cgroup/memory.stat");
  if (limit === undefined || used === undefined) {
    limit = num(readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
    used = num(readFile("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
    stat = readFile("/sys/fs/cgroup/memory/memory.stat");
  }
  // Unlimited shows as "max" (v2) or a huge number (v1).
  if (limit === undefined || used === undefined || limit >= 2 ** 60) return undefined;
  const cache = Number(/^(?:total_)?inactive_file (\d+)$/m.exec(stat ?? "")?.[1] ?? 0);
  return Math.max(0, limit - Math.max(0, used - cache));
}

export function checkThreads({ env = process.env, cpus = availableParallelism(), readFile = read } = {}) {
  const forced = whole(env.BOSSMAN_CHECK_THREADS);
  if (forced >= 1) return forced;
  const quota = cgroupCpus(readFile);
  const usable = Math.max(1, Math.floor(Math.min(cpus, quota ?? Infinity)));
  const slots = whole(env.BOSSMAN_CHECK_SLOTS) || whole(readFile(env.CHECK_ALL_PAIR_PROOF || PROOF)) || 1;
  const byCpu = Math.min(DEFAULT_MAX, Math.floor(usable / slots));
  const free = cgroupFreeMemory(readFile);
  const byMemory = free === undefined ? Infinity : Math.floor(free / slots / BYTES_PER_WORKER);
  return Math.max(1, Math.min(byCpu, byMemory));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(checkThreads());
