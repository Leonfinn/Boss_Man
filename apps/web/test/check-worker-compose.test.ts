// BOS-1550: the compose file Boss Man shows for a new check worker is the repo's deploy/check-worker/compose.yaml, filled in.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import template from "../src/pages/settings/check-worker-compose.yaml?raw";
import { workerComposeFile, workerSocketUrl } from "../src/pages/settings/check-worker-compose";

const COMMIT = "ab12".repeat(10);

describe("check worker compose file (BOS-1550)", () => {
  it("the web copy is identical to deploy/check-worker/compose.yaml", () => {
    expect(template).toBe(readFileSync(new URL("../../../deploy/check-worker/compose.yaml", import.meta.url), "utf8"));
  });

  it("fills in the address, the commit twice, the slots and the token", () => {
    const out = workerComposeFile({ url: workerSocketUrl("https://boss.example.org/"), commit: COMMIT, slots: 3, token: "bmw_example" });
    expect(out).toContain("wss://boss.example.org/api/check-worker/connect");
    expect(out).toContain(`Boss_Man.git#${COMMIT}`);
    expect(out).toContain(`BOSSMAN_IMAGE_COMMIT: "${COMMIT}"`);
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
    const out = workerComposeFile({ url: "wss://x/api/check-worker/connect", commit: COMMIT, slots: 1, token: "t" });
    expect(out).toContain("RUNNER_ADDONS: agent-browser");
    expect(out).toContain('WITH_HARNESS: "0"');
  });

  it("keeps the zeros when no runner has reported a commit, and never trusts a malformed one", () => {
    expect(workerComposeFile({ url: "wss://x/api/check-worker/connect", commit: null, slots: 1, token: "t" })).toContain("0".repeat(40));
    expect(workerComposeFile({ url: "wss://x/api/check-worker/connect", commit: "main; rm -rf /", slots: 1, token: "t" })).not.toContain("rm -rf");
  });

  it("quotes a token so it cannot break out of the YAML string", () => {
    expect(workerComposeFile({ url: "wss://x/api/check-worker/connect", commit: COMMIT, slots: 1, token: 'a"b\nc' })).toContain('content: "a\\"b\\nc"');
  });
});
