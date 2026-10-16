import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  // The artwork lives in assets/brand at the repository root.
  server: {
    fs: { allow: [repoRoot] },
    // `pnpm dev` here plus the server on 3100: the browser only ever talks to one origin.
    proxy: { "/api": "http://127.0.0.1:3100" },
  },
  // Every asset is a file, so the page works under a CSP without data: fonts or scripts.
  build: { outDir: "dist", assetsInlineLimit: 0 },
});
