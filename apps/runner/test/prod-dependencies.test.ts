import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The runner image installs with `pnpm install --prod`, so every package the
// runner's source imports at run time must be in "dependencies", not
// "devDependencies" (BOS-644: the canary died on a missing @modelcontextprotocol/sdk).
const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe("runner production dependencies", () => {
  it("has every runtime-imported package in dependencies", () => {
    const missing = new Set<string>();
    for (const f of sources(join(root, "src"))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?from\s+"([^"./][^"]*)"/gm)) {
        const spec = m[1] ?? "";
        const parts = spec.split("/");
        const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
        if (!name || name.startsWith("node:")) continue;
        if (!(name in (pkg.dependencies ?? {})) && name in (pkg.devDependencies ?? {})) missing.add(name);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
