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
  // Two pages: the owner's app, and the public feedback portal, which loads none of the app.
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: fileURLToPath(new URL("index.html", import.meta.url)), portal: fileURLToPath(new URL("portal.html", import.meta.url)) } },
  },
});
