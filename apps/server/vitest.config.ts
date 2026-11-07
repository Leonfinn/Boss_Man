import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import { defineConfig } from "vitest/config";
import { checkThreads } from "../../scripts/check-threads.mjs";
import { guardVitest } from "../../scripts/vitest-guard.mjs";

// Keeps whole-suite runs at the merge gate for agent sessions; see scripts/vitest-guard.mjs.
guardVitest();

// Each worker holds its own in-process Postgres: measured ~0.9 GB per worker plus ~0.6 GB for the
// rest (peak 1.5 GB at 1 worker, 2.3 GB at 2, 3.3 GB at 4).
// Sized from the memory still FREE in the cgroup (limit minus what everyone in it is using now, not
// counting reclaimable file cache), not from the limit: on a shared runner several agents run this
// suite at once, and sizing from the limit made each of them assume it had the box to itself, so
// together they went over 8 GB and the OOM killer took one. Backing off by headroom bounds every
// caller, including plain `pnpm test`, without a lock that a crashed run could leave held. It can still
// race when two runs start in the same second, so check-all.sh also caps the count
// (BOSSMAN_TEST_MAX_WORKERS). BOSSMAN_TEST_WORKERS forces an exact count. CI (16 GB, empty) still gets 4.
const GB = 2 ** 30;
function readNum(path: string) {
  try {
    const v = readFileSync(path, "utf8").trim();
    const n = Number(v);
    return v === "max" || !Number.isFinite(n) ? undefined : n;
  } catch {
    return undefined;
  }
}
function workers() {
  const forced = Number(process.env.BOSSMAN_TEST_WORKERS);
  if (forced >= 1) return Math.floor(forced);
  let free = freemem();
  const max = readNum("/sys/fs/cgroup/memory.max"); // cgroup v2; "max" = unlimited
  const current = readNum("/sys/fs/cgroup/memory.current");
  if (max !== undefined && current !== undefined) {
    let cache = 0;
    try {
      cache = Number(/^inactive_file (\d+)/m.exec(readFileSync("/sys/fs/cgroup/memory.stat", "utf8"))?.[1] ?? 0);
    } catch {}
    free = Math.min(free, max - (current - cache));
  }
  // Never more than the check's CPU budget either (BOS-674, scripts/check-threads.mjs), so a small host isn't overrun.
  const cap = Math.min(checkThreads(), Number(process.env.BOSSMAN_TEST_MAX_WORKERS) >= 1 ? Math.floor(Number(process.env.BOSSMAN_TEST_MAX_WORKERS)) : 4);
  // 0.6 GB base + 0.9 GB per worker, keeping 1 GB spare for the rest of the run.
  return Math.max(1, Math.min(cap, Math.floor((free / GB - 1.6) / 0.9)));
}

export default defineConfig({
  test: {
    // Each test file opens its own in-process Postgres; scrypt hashing is deliberately slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: workers(),
    // The merge check sets BOSSMAN_TEST_TIMES_FILE to also get a JSON report, for per-file times in the gate store (BOS-654).
    ...(process.env.BOSSMAN_TEST_TIMES_FILE ? { reporters: ["default", "json"], outputFile: { json: process.env.BOSSMAN_TEST_TIMES_FILE } } : {}),
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/live-run-tokens.ts"],
  },
});
