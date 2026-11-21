// BOS-2164: the maintenance alerts link to the Updates page they name, not the bare Settings menu.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("maintenance alert links", () => {
  it("every link opens #/settings/updates", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/services/maintenance.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/link: "#\/settings"/);
    expect(src).toContain('link: "#/settings/updates"');
  });
});
