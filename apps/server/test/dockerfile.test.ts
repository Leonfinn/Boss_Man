import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The host deployer hands over with SIGUSR1/SIGUSR2 (docs/09-self-deploy.md); a wrapper process such as the tsx CLI swallows them.
it("the server image runs node directly, so the handover signals reach the server", () => {
  const cmd = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8").match(/^CMD (.+)$/m)?.[1];
  expect(JSON.parse(cmd!)[0]).toBe("node");
});
