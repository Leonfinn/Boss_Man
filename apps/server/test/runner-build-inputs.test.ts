// BOS-1648: "is a runner update needed?" is decided from what the runner images are built from, not a hand-kept list.
// RUNNER_BUILD_INPUTS must be exactly the Dockerfiles that "Build and update runners" builds plus every repository
// path their COPY lines take in; a new COPY (or a dropped one) fails here until the list follows it.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNNER_BUILD_INPUTS, RUNNER_CODE_PATHS, touchesRunnerCode } from "@boss-man/shared";

const ROOT = new URL("../../..", import.meta.url).pathname;
const DOCKERFILES = ["apps/runner/Dockerfile", "apps/launcher/Dockerfile", "apps/netguard/Dockerfile"];

/** The repository paths a Dockerfile's COPY/ADD lines take in (folders end in "/"); a COPY --from=stage reads no repo file. */
function copySources(dockerfile: string): string[] {
  const text = readFileSync(join(ROOT, dockerfile), "utf8").replace(/\\\r?\n/g, " ");
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(COPY|ADD)\s+(.*)$/i);
    if (!m) continue;
    const words = m[2]!.trim().split(/\s+/);
    if (words.some((w) => w.startsWith("--from="))) continue;
    const args = words.filter((w) => !w.startsWith("--"));
    for (const src of args.slice(0, -1)) {
      const path = src.replace(/^\.\//, "").replace(/\/$/, "");
      out.push(statSync(join(ROOT, path)).isDirectory() ? `${path}/` : path);
    }
  }
  return out;
}

describe("runner build inputs come from the Dockerfiles (BOS-1648)", () => {
  it("every image the runner update builds is one of the Dockerfiles read here", () => {
    const update = readFileSync(join(ROOT, "scripts/update-runner.sh"), "utf8");
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    expect(update).toContain("-f apps/runner/Dockerfile");
    expect(update).toContain("-f apps/netguard/Dockerfile");
    // The launcher is built through compose (`docker compose build launcher`), whose service names its Dockerfile.
    expect(update).toMatch(/docker compose build launcher/);
    expect(compose).toContain("dockerfile: apps/launcher/Dockerfile");
  });

  it("RUNNER_BUILD_INPUTS is exactly the Dockerfiles and what they COPY in", () => {
    const fromBuild = new Set([...DOCKERFILES, ...DOCKERFILES.flatMap(copySources)]);
    expect([...new Set(RUNNER_BUILD_INPUTS)].sort()).toEqual([...fromBuild].sort());
  });

  it("the pattern counts what the images take in and nothing else beside it", () => {
    for (const p of ["apps/runner/src/main.ts", "apps/runner/Dockerfile", "apps/runner/claude-pack/package.json", "packages/shared/src/go-live.ts", "scripts/check-slot.sh", "pnpm-lock.yaml", "package.json", "NOTICE", "apps/launcher/tsconfig.build.json", "apps/netguard/netguard.sh"]) {
      expect(touchesRunnerCode([p]), p).toBe(true);
    }
    for (const p of ["apps/runner/test/x.test.ts", "packages/shared/test/go-live-words.test.ts", "apps/netguard/netguard.test.sh", "apps/server/package.json", "apps/server/src/app.ts", "apps/web/src/x.tsx", "scripts/deploy.sh", "docs/x.md", "apps/runner-extra/y"]) {
      expect(touchesRunnerCode([p]), p).toBe(false);
    }
  });

  it("deploy.sh's needs_runner and deploy-staging.sh's runner build use the same rule", () => {
    for (const file of ["scripts/deploy.sh", "scripts/deploy-staging.sh"]) {
      const sh = readFileSync(join(ROOT, file), "utf8").match(/grep -Eq '(\^\(apps\/runner[^']*)'/)![1]!;
      expect(RUNNER_CODE_PATHS.source.replace(/\\\//g, "/"), file).toBe(sh);
    }
  });
});
