import { defineConfig } from "vitest/config";
import { guardVitest } from "../../scripts/vitest-guard.mjs";

// Keeps whole-suite runs at the merge gate for agent sessions; see scripts/vitest-guard.mjs.
guardVitest();

export default defineConfig({});
