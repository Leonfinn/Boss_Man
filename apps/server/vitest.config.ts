import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { defineConfig } from "vitest/config";

// Each worker holds its own in-process Postgres: measured ~0.9 GB per worker plus ~0.6 GB for the
// rest (peak 1.5 GB at 1 worker, 2.3 GB at 2, 3.3 GB at 4). A 4 GB runner container got SIGKILLed
// at 4 workers with agents running beside the check, so leave 2 GB free: 1 worker per GB above that.
// Set BOSSMAN_TEST_WORKERS to override. CI (16 GB) still gets 4.
function workers() {
  const forced = Number(process.env.BOSSMAN_TEST_WORKERS);
  if (forced >= 1) return Math.floor(forced);
  let limit = totalmem();
  try {
    const max = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(); // cgroup v2; "max" = unlimited
    if (max !== "max") limit = Math.min(limit, Number(max));
  } catch {}
  return Math.max(1, Math.min(4, Math.floor(limit / 2 ** 30 - 2)));
}

export default defineConfig({
  test: {
    // Each test file opens its own in-process Postgres; scrypt hashing is deliberately slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: workers(),
    globalSetup: ["test/global-setup.ts"],
  },
});
