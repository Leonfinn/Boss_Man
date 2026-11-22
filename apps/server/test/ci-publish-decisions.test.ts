// BOS-2137 (background lane): the decisions a CI wait makes before any network call. Each helper is pure:
// `ciStops` reads only the outcome's kind, and the file helpers only test the changed paths. Made-up inputs only.
import { describe, expect, it } from "vitest";
import { ciStops, needsEarlyGithubRun, touchesWorkflows, type CiOutcome } from "../src/services/ci-publish.js";
import type { CiStatus } from "../src/services/git-hosts.js";

const failedStatus: CiStatus = { state: "failed", failed: [], waiting: [], billing: false };

describe("CI wait decisions (BOS-2137)", () => {
  describe("ciStops", () => {
    const stopsTheAttempt: CiOutcome[] = [
      { kind: "failed", status: failedStatus },
      { kind: "refused", message: "the token can't read Actions" },
      { kind: "error", message: "the request kept failing" },
      { kind: "timeout", waiting: ["check"] },
      { kind: "superseded", newerSha: "b".repeat(40) },
      { kind: "cancelled", runs: ["check"], rerunTried: false },
    ];

    it("stops the attempt for each outcome that ends it without merging", () => {
      for (const outcome of stopsTheAttempt) expect(ciStops(outcome), outcome.kind).toBe(true);
    });

    const carriesOn: CiOutcome[] = [
      { kind: "passed" },
      { kind: "passed", reused: true, flaky: ["apps/web/test/one.test.ts"] },
      { kind: "none" },
      { kind: "no_workflows" },
      { kind: "stopped" },
      { kind: "known_red", jobs: ["check"], refs: ["BOS-1"] },
    ];

    it("lets the gate's own check carry on for every other outcome", () => {
      for (const outcome of carriesOn) expect(ciStops(outcome), outcome.kind).toBe(false);
    });
  });

  describe("touchesWorkflows", () => {
    it("is true for a workflow file at the repository root", () => {
      expect(touchesWorkflows([".github/workflows/ci.yml"])).toBe(true);
      expect(touchesWorkflows([".github/workflows/nested/thing.yaml"])).toBe(true);
    });

    it("is false for other files, an empty list, and a nested .github folder", () => {
      expect(touchesWorkflows([])).toBe(false);
      expect(touchesWorkflows(["apps/web/src/App.tsx", "docs/readme.md"])).toBe(false);
      expect(touchesWorkflows([".github/workflows"])).toBe(false);
      expect(touchesWorkflows(["apps/web/.github/workflows/ci.yml"])).toBe(false);
    });
  });

  describe("needsEarlyGithubRun", () => {
    it("is true for a changed file that only GitHub's own jobs need", () => {
      expect(needsEarlyGithubRun(["Dockerfile"])).toBe(true);
      expect(needsEarlyGithubRun(["apps/web/Dockerfile"])).toBe(true);
      expect(needsEarlyGithubRun(["docker-compose.yml"])).toBe(true);
      expect(needsEarlyGithubRun(["deploy/stack.yml"])).toBe(true);
      expect(needsEarlyGithubRun(["scripts/check-quick.sh"])).toBe(true);
      expect(needsEarlyGithubRun(["skills/thing/SKILL.md"])).toBe(true);
      expect(needsEarlyGithubRun(["pnpm-lock.yaml"])).toBe(true);
      expect(needsEarlyGithubRun(["apps/runner/src/index.ts"])).toBe(true);
      expect(needsEarlyGithubRun(["apps/web/check-worker.ts"])).toBe(true);
      expect(needsEarlyGithubRun(["packages/shared/src/protocol.ts"])).toBe(true);
    });

    it("is false for ordinary source files and for a workflow edit", () => {
      expect(needsEarlyGithubRun([])).toBe(false);
      expect(needsEarlyGithubRun(["apps/web/src/App.tsx"])).toBe(false);
      expect(needsEarlyGithubRun([".github/workflows/ci.yml"])).toBe(false);
      // A workflow edit is never pushed before review, even beside an image file (BOS-1664, security F1).
      expect(needsEarlyGithubRun(["Dockerfile", ".github/workflows/ci.yml"])).toBe(false);
    });
  });
});
