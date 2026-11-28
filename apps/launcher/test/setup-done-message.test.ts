import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { doneMessage } from "../src/setup.js";

describe("setup's closing message (BOS-2846)", () => {
  it("names both volumes by their real names and gives one copy command", () => {
    const m = doneMessage();
    expect(m).toContain("master.key is in the Docker volume boss-man_config");
    expect(m).toContain("boss-man_db-secret");
    expect(m).toContain("-v boss-man_config:/from/config:ro -v boss-man_db-secret:/from/db-secret:ro");
    expect(m).toContain("tar czf /to/boss-man-keys.tgz -C /from .");
    expect(m).toMatch(/another machine/);
  });

  it("uses the project name and database image the install passes in", () => {
    const m = doneMessage("home_bm", "registry.example.com/pg:17");
    expect(m).toContain("home_bm_config");
    expect(m).toContain("home_bm_db-secret");
    expect(m).toContain("registry.example.com/pg:17 tar czf");
  });

  it("ignores a name that is not a plain project or image name", () => {
    const m = doneMessage("x; rm -rf /", "img && evil");
    expect(m).toContain("boss-man_config");
    expect(m).not.toContain("evil");
  });

  it("gives setup the project name and image to print", () => {
    const compose = readFileSync(new URL("../../../docker-compose.images.yml", import.meta.url), "utf8");
    expect(compose).toContain("BOSSMAN_PROJECT_NAME: ${COMPOSE_PROJECT_NAME:-boss-man}");
    expect(compose).toContain("BOSSMAN_DB_IMAGE: ${BOSSMAN_DB_IMAGE:-pgvector/pgvector:0.8.7-pg17-bookworm}");
  });
});
