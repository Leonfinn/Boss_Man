// The hand-started compose stack (DR-050, BOS-972): the claude-pack installer must be a real service under
// `services:`, not a key inside the `x-runner` anchor. A service can only depend on another real service, so a
// runner-app-co that depends on an anchor key makes `docker compose up` reject the whole file (Dougal).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Compose = {
  services?: Record<string, { depends_on?: Record<string, unknown> | string[]; volumes?: string[]; profiles?: string[] }>;
  "x-runner"?: unknown;
};

function readCompose(): Compose {
  return parse(readFileSync(path.join(root, "docker-compose.yml"), "utf8"), { merge: true }) as Compose;
}

describe("docker-compose.yml", () => {
  it("declares claude-pack as a real service under services:", () => {
    const compose = readCompose();
    expect(compose.services).toBeDefined();
    expect(compose.services?.["claude-pack"]).toBeDefined();
    expect(compose.services?.["claude-pack"]).toMatchObject({ restart: "no" });
    expect(compose.services?.["claude-pack"]?.profiles).toContain("runners");
  });

  it("runner-app-co depends on the claude-pack service and waits for it to finish", () => {
    const compose = readCompose();
    const runner = compose.services?.["runner-app-co"];
    expect(runner).toBeDefined();
    expect(runner?.depends_on).toMatchObject({ "claude-pack": { condition: "service_completed_successfully" } });
    expect(compose.services?.["claude-pack"]).toBeDefined();
  });

  it("the runner mounts the pack volume read-only and the installer mounts it writable", () => {
    const compose = readCompose();
    expect(compose.services?.["runner-app-co"]?.volumes).toContain("claude-pack:/opt/bossman-claude:ro");
    expect(compose.services?.["claude-pack"]?.volumes).toContain("claude-pack:/opt/bossman-claude");
  });

  it("claude-pack is not a leftover key inside the x-runner anchor", () => {
    const compose = readCompose();
    const anchor = compose["x-runner"] as Record<string, unknown> | undefined;
    expect(anchor).toBeDefined();
    expect(anchor?.["claude-pack"]).toBeUndefined();
  });
});
