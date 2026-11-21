// BOS-2164: the overdue-update banner's link opens the Updates page, not the Settings menu.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("update banner link", () => {
  it("points at #/settings/updates, never the bare menu", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
    expect(src).toContain('<a href="#/settings/updates">choose in Settings → Server and runner → Updates</a>');
    expect(src).not.toContain('href="#/settings"');
  });
});
