// One CPU budget for every part of a check (BOS-674): how many threads one check (or one hand test run) may keep busy.
// Every package's vitest config takes its maxWorkers from checkThreads(), and check-all.sh / check-quick.sh export the
// same number to the native tools: GOMAXPROCS for tsc (TypeScript 7 is a Go binary), RAYON_NUM_THREADS and
// TOKIO_WORKER_THREADS for the web build (Vite 8 bundles with Rolldown, which is Rust).
//
// BOSSMAN_CHECK_THREADS (a whole number >= 1) sets it outright. Otherwise it is this check slot's share of the CPUs the
// container may use (CPU affinity and the cgroup's cpu.max quota, so a Docker --cpus limit counts; no hardcoded core
// counts), capped at DEFAULT_MAX so one check never fills a big host, and never below 1. The slot count is
// BOSSMAN_CHECK_SLOTS, else the number check-all.sh reads from its proof file, else 1.
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

export function checkThreads({ env = process.env, cpus = availableParallelism(), readFile = read } = {}) {
  const forced = whole(env.BOSSMAN_CHECK_THREADS);
  if (forced >= 1) return forced;
  const quota = cgroupCpus(readFile);
  const usable = Math.max(1, Math.floor(Math.min(cpus, quota ?? Infinity)));
  const slots = whole(env.BOSSMAN_CHECK_SLOTS) || whole(readFile(env.CHECK_ALL_PAIR_PROOF || PROOF)) || 1;
  return Math.max(1, Math.min(DEFAULT_MAX, Math.floor(usable / slots)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(checkThreads());
