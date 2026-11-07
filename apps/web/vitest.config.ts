import { defineConfig, mergeConfig } from "vitest/config";
// @ts-ignore plain .mjs shared by every package's test config, no types
import { guardVitest } from "../../scripts/vitest-guard.mjs";
import viteConfig from "./vite.config";

// Keeps whole-suite runs at the merge gate for agent sessions; see scripts/vitest-guard.mjs.
// This lives here, not in vite.config.ts, so the production build (the server Dockerfile's web
// stage copies only apps/web) never loads test tooling from outside its build context.
guardVitest();

export default mergeConfig(viteConfig, defineConfig({}));
