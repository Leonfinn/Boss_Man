import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file opens its own in-process Postgres; scrypt hashing is deliberately slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
