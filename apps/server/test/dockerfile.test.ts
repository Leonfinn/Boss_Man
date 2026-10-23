import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The host deployer hands over with SIGUSR1/SIGUSR2 (docs/09-self-deploy.md); a wrapper process such as the tsx CLI swallows them.
it("the server image runs node directly, so the handover signals reach the server", () => {
  const cmd = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8").match(/^CMD (.+)$/m)?.[1];
  expect(JSON.parse(cmd!)[0]).toBe("node");
});

// The web UI builds in its own stage from only the files it copies; a workspace package it imports must be copied too.
it("the web build stage copies every workspace package the web app depends on", () => {
  const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const stage = docker.slice(docker.indexOf(" AS web"), docker.indexOf("FROM", docker.indexOf(" AS web")));
  const web = JSON.parse(readFileSync(new URL("../../web/package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const local = Object.entries({ ...web.dependencies, ...web.devDependencies }).filter(([, v]) => v.startsWith("workspace:"));
  for (const [name] of local) {
    const dir = `packages/${name.replace("@boss-man/", "")}`;
    expect(stage, name).toContain(`COPY ${dir}/package.json ${dir}/`);
    expect(stage, name).toContain(`COPY ${dir} ${dir}`);
  }
});
