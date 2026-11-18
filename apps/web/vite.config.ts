/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { preCompress } from "./compress";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  // Under a busy shared runner, jsdom tests can take over the 5 s default (as the server and runner suites already allow for).
  // browser-setup.ts: one shared, deadline-bound Chromium start for every browser test, warmed before its tests (BOS-1784).
  test: { testTimeout: 30_000, hookTimeout: 30_000, setupFiles: ["./test/browser-setup.ts"] },
  // Writes .br/.gz next to each built file (BOS-411), which the server serves without re-compressing.
  plugins: [react(), preCompress()],
  // The artwork lives in assets/brand at the repository root.
  server: {
    fs: { allow: [repoRoot] },
    // `pnpm dev` here plus the server on 3100: the browser only ever talks to one origin.
    proxy: { "/api": "http://127.0.0.1:3100" },
  },
  // Every asset is a file, so the page works under a CSP without data: fonts or scripts.
  // Two pages: the owner's app, and the public feedback portal, which loads none of the app.
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: fileURLToPath(new URL("index.html", import.meta.url)), portal: fileURLToPath(new URL("portal.html", import.meta.url)), confirm: fileURLToPath(new URL("confirm.html", import.meta.url)) } },
  },
});
