// BOS-1550: the compose file Boss Man shows for a new check worker is the repo's deploy/check-worker/compose.yaml, filled in.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import template from "../src/pages/settings/check-worker-compose.yaml?raw";
import { workerComposeFile, workerSocketUrl } from "../src/pages/settings/check-worker-compose";

describe("check worker compose file (BOS-1550)", () => {
  it("the web copy is identical to deploy/check-worker/compose.yaml", () => {
    expect(template).toBe(readFileSync(new URL("../../../deploy/check-worker/compose.yaml", import.meta.url), "utf8"));
  });

  it("fills in the address, the slots and the token, and has no commit for the owner to keep up to date (BOS-1570)", () => {
    const out = workerComposeFile({ url: workerSocketUrl("https://boss.example.org/"), slots: 3, token: "bmw_example" });
    expect(out).toContain("wss://boss.example.org/api/check-worker/connect");
    expect(out).toContain("Boss_Man.git#main");
    expect(out).not.toContain("BOSSMAN_IMAGE_COMMIT");
    expect(out).not.toContain("CHANGE THIS (commit");
    expect(out).not.toMatch(/[0-9a-f]{40}/);
    expect(out).toContain('BOSSMAN_CHECK_SLOTS: "3"');
    expect(out).toContain('content: "bmw_example"');
    expect(out).not.toContain("PASTE-THE-WORKER-TOKEN-HERE");
    expect(out).not.toContain("boss.example.com");
    expect(out).not.toContain("0".repeat(40));
    // The hardening is still there, and the token is never in the environment.
    for (const line of ["cap_drop: [ALL]", 'security_opt: ["no-new-privileges:true"]', "oom_score_adj: 500", "mem_limit: 8g"]) expect(out).toContain(line);
    expect(out).not.toMatch(/\n\s+ports:/);
    expect(out).not.toContain("docker.sock");
    expect(out).not.toMatch(/BOSSMAN_CHECK_WORKER_TOKEN:/);
  });

  it("builds the image with a browser and without the agent harness (BOS-1553)", () => {
    const out = workerComposeFile({ url: "wss://x/api/check-worker/connect", slots: 1, token: "t" });
    expect(out).toContain("RUNNER_ADDONS: agent-browser");
    expect(out).toContain('WITH_HARNESS: "0"');
  });

  it("quotes a token so it cannot break out of the YAML string", () => {
    expect(workerComposeFile({ url: "wss://x/api/check-worker/connect", slots: 1, token: 'a"b\nc' })).toContain('content: "a\\"b\\nc"');
  });
});
