import { defineConfig } from "vitest/config";
import { checkThreads } from "../../scripts/check-threads.mjs";
import { guardVitest } from "../../scripts/vitest-guard.mjs";

// Keeps whole-suite runs at the merge gate for agent sessions; see scripts/vitest-guard.mjs.
guardVitest();

// Worker cap: one CPU budget for every part of a check (see scripts/check-threads.mjs).
export default defineConfig({ test: { setupFiles: ["./test/setup-env.ts"], testTimeout: 60_000, hookTimeout: 30_000, maxWorkers: checkThreads(),
  // CI sets this so a red run can name the failing tests in a public annotation (BOS-1705).
  ...(process.env.BOSSMAN_RUNNER_TEST_REPORT ? { reporters: ["default", "json"], outputFile: { json: process.env.BOSSMAN_RUNNER_TEST_REPORT } } : {}) } });
