import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file opens its own in-process Postgres; scrypt hashing is deliberately slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each worker holds its own Postgres; one per CPU ran a 4 GB runner out of memory on a 16-CPU host.
    maxWorkers: 4,
  },
});
