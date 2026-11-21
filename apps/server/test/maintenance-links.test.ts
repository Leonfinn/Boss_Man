// BOS-2164: the maintenance alerts link to the Updates page they name, not the bare Settings menu, and no text
// names a Settings page that doesn't exist.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("maintenance alert links", () => {
  it("every link opens #/settings/updates", () => {
    const src = readFileSync(join(root, "server/src/services/maintenance.ts"), "utf8");
    expect(src).not.toMatch(/link: "#\/settings"/);
    expect(src).toContain('link: "#/settings/updates"');
  });
});

describe("Settings page names in text", () => {
  // Since BOS-1492 the group "Server and runner" holds Updates, Limits and checks, Runner, Email, This server, Devices and privacy.
  const BAD = [
    /Server and runner\s*[→›>]\s*Server(?!\s+and)\b/,
    /Server and runner\s*[→›>]\s*This host/,
    /Server and runner\s*[→›>]\s*Checks\b/,
    /Server and runner\s*[→›>]\s*Agents at once/,
  ];
  it("no string in web or server code uses a retired page name", () => {
    const files = [...walk(join(root, "web/src")), ...walk(join(root, "server/src"))];
    const hits: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (BAD.some((re) => re.test(line))) hits.push(`${f}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
