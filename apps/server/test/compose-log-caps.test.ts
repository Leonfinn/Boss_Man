import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// BOS-2161: Docker keeps container logs forever by default. Every running service must carry the capped `logging:` block.
const parse = (text: string) => parseYaml(text, { merge: true, logLevel: "error" });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type Service = { logging?: { driver?: string; options?: Record<string, string> } };
const services = (file: string): Record<string, Service> => parse(readFileSync(path.join(root, file), "utf8")).services;
// Build-only service that never runs.
const NOT_RUN = new Set(["netguard"]);
// Overlays that only adjust a service the base file already defines inherit its logging.
const ALL = ["docker-compose.yml", "deploy/truenas-bluegreen.yml", "deploy/tool-servers.yml", "deploy/penpot.yml", "deploy/ntfy.yml", "deploy/ntfy-bluegreen.yml", "deploy/tailscale.yml", "deploy/tailscale-bluegreen.yml", "deploy/cloudflared.yml", "deploy/check-worker/compose.yaml"];

describe("compose log caps", () => {
  for (const file of ALL) {
    it(`${file}: every service caps its log`, () => {
      const missing = Object.entries(services(file))
        .filter(([name, s]) => !NOT_RUN.has(name) && !s.logging?.options?.["max-size"])
        .map(([name]) => name);
      const base = file === "docker-compose.yml" ? {} : services("docker-compose.yml");
      const inherited = Object.keys(base).filter((n) => base[n]!.logging?.options?.["max-size"]);
      expect(missing.filter((n) => !inherited.includes(n)), `no log cap in ${file}`).toEqual([]);
    });
  }

  it("the cap is json-file with a size and a file count the owner can change from .env", () => {
    const main = services("docker-compose.yml");
    for (const n of ["db", "server", "launcher", "claude-pack"]) {
      expect(main[n]!.logging?.driver, n).toBe("json-file");
      expect(main[n]!.logging?.options?.["max-size"], n).toContain("BOSSMAN_LOG_MAX_SIZE");
      expect(main[n]!.logging?.options?.["max-file"], n).toContain("BOSSMAN_LOG_MAX_FILE");
    }
    expect(main["runner-app-co"]!.logging?.driver).toBe("json-file");
  });
});
