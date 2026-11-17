import { describe, expect, it } from "vitest";
import { deploysNothing, GO_LIVE_WAIT_MAX_MS, goLiveWaitWords, touchesRunnerUpdate } from "../src/go-live.js";

describe("deploysNothing (BOS-1609)", () => {
  it("is true when every file is a test, a doc or CI", () => {
    expect(deploysNothing(["apps/server/test/compose-memory-limits.test.ts"])).toBe(true);
    expect(deploysNothing(["packages/shared/src/go-live.test.ts", "scripts/deploy.test.sh", "apps/web/tests/e2e/board.spec.ts"])).toBe(true);
    expect(deploysNothing(["docs/10-migrations.md", "docs/img/board.png", "CLAUDE.md", "README.md"])).toBe(true);
    expect(deploysNothing([".github/workflows/ci.yml"])).toBe(true);
    // A package's vitest config only steers its tests (BOS-1693).
    expect(deploysNothing(["apps/runner/vitest.config.ts", "apps/web/vitest.config.mts", "vitest.workspace.ts"])).toBe(true);
  });

  it("is false when any file can go live, and for an empty list", () => {
    expect(deploysNothing(["apps/server/test/x.test.ts", "apps/server/src/services/review.ts"])).toBe(false);
    expect(deploysNothing(["scripts/check-all.sh"])).toBe(false);
    expect(deploysNothing(["docker-compose.yml"])).toBe(false);
    expect(deploysNothing(["apps/server/drizzle/0165_x.sql"])).toBe(false);
    // Markdown inside an app or a skill can ship in an image.
    expect(deploysNothing(["apps/runner/claude-pack/CLAUDE.md"])).toBe(false);
    expect(deploysNothing(["skills/penpot/SKILL.md"])).toBe(false);
    // A name that only looks like a test or a doc.
    expect(deploysNothing(["apps/server/src/testing.ts", "apps/server/src/latest/x.ts", "apps/web/src/docs/page.tsx"])).toBe(false);
    expect(deploysNothing([])).toBe(false);
  });
});

describe("touchesRunnerUpdate (BOS-1467)", () => {
  it("is true only for the runner update script", () => {
    expect(touchesRunnerUpdate(["README.md", "scripts/update-runner.sh"])).toBe(true);
    expect(touchesRunnerUpdate(["scripts/update-runner.test.sh", "scripts/update-runner.sh.bak", "apps/server/src/x.ts"])).toBe(false);
    expect(touchesRunnerUpdate([])).toBe(false);
  });
});

describe("goLiveWaitWords: what the board says a merged ticket waits for (BOS-1106)", () => {
  it("gives each wait its own sentence, all starting \"waiting for go-live\"", () => {
    const server = goLiveWaitWords("server");
    const runner = goLiveWaitWords("runner");
    const both = goLiveWaitWords("both");

    for (const words of [server, runner, both]) expect(words.startsWith("waiting for go-live")).toBe(true);
    expect(new Set([server, runner, both]).size).toBe(3);
  });

  it("names the server update for a server wait", () => {
    const words = goLiveWaitWords("server");
    expect(words).toContain("server update");
    expect(words).not.toContain("runner rebuild");
  });

  it("names the runner rebuild for a runner wait", () => {
    const words = goLiveWaitWords("runner");
    expect(words).toContain("runner rebuild");
    expect(words).not.toContain("server update");
  });

  it("names both the server update and the runner rebuild for a both wait", () => {
    const words = goLiveWaitWords("both");
    expect(words).toContain("server update");
    expect(words).toContain("runner rebuild");
  });

  it("lets a ticket wait three days before the watchdog looks at it again", () => {
    expect(GO_LIVE_WAIT_MAX_MS).toBe(3 * 24 * 60 * 60 * 1000);
    expect(GO_LIVE_WAIT_MAX_MS).toBe(259_200_000);
  });
});
