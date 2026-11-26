import { describe, expect, it } from "vitest";
import {
  deploysNothing,
  GO_LIVE_WAIT_MAX_MS,
  goLiveWaitWords,
  isLiveCheckWait,
  ownerApprovedFiles,
  touchesRunnerCode,
  touchesRunnerUpdate,
  watchEndsAt,
  WATCH_DEFAULT_DAYS,
} from "../src/go-live.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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

describe("watchEndsAt (BOS-1907)", () => {
  it("uses the recorded watch date when there is one", () => {
    const ends = watchEndsAt({
      watchUntil: "2026-12-25T00:00:00.000Z",
      liveAt: "2026-11-01T00:00:00.000Z",
      mergedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(ends?.toISOString()).toBe("2026-12-25T00:00:00.000Z");
  });

  it("otherwise adds the default watch days to go-live", () => {
    const ends = watchEndsAt({ liveAt: "2026-11-01T00:00:00.000Z", mergedAt: "2026-10-01T00:00:00.000Z" });
    expect(ends?.toISOString()).toBe(new Date(new Date("2026-11-01T00:00:00.000Z").getTime() + WATCH_DEFAULT_DAYS * DAY_MS).toISOString());
  });

  it("otherwise adds the default watch days to the merge", () => {
    const ends = watchEndsAt({ mergedAt: "2026-10-01T00:00:00.000Z" });
    expect(ends?.toISOString()).toBe(new Date(new Date("2026-10-01T00:00:00.000Z").getTime() + WATCH_DEFAULT_DAYS * DAY_MS).toISOString());
  });

  it("is null when the ticket has neither a watch date nor a go-live or merge time", () => {
    expect(watchEndsAt({})).toBeNull();
    expect(watchEndsAt({ watchUntil: null, liveAt: null, mergedAt: null })).toBeNull();
  });
});

describe("touchesRunnerCode (BOS-1693)", () => {
  it("is true for a path that ships in the runner image", () => {
    expect(touchesRunnerCode(["apps/runner/src/check-jobs.ts"])).toBe(true);
    expect(touchesRunnerCode(["packages/shared/src/go-live.ts"])).toBe(true);
    expect(touchesRunnerCode(["README.md", "apps/launcher/src/index.ts"])).toBe(true);
  });

  it("is false for a test, a doc or CI, even under a runner folder", () => {
    expect(touchesRunnerCode(["apps/runner/src/check-jobs.test.ts"])).toBe(false);
    expect(touchesRunnerCode(["apps/runner/test/check-jobs.test.ts", "docs/10-migrations.md"])).toBe(false);
  });

  it("is false when no changed path is runner code", () => {
    expect(touchesRunnerCode(["apps/web/src/pages/Board.tsx", "apps/server/src/app.ts"])).toBe(false);
    expect(touchesRunnerCode([])).toBe(false);
  });
});

describe("ownerApprovedFiles (BOS-1094)", () => {
  it("keeps only the owner-approved paths, in the order given", () => {
    expect(ownerApprovedFiles(["CLAUDE.md", "apps/web/src/x.ts", "scripts/check-all.sh"])).toEqual(["CLAUDE.md", "scripts/check-all.sh"]);
    expect(ownerApprovedFiles(["scripts/check-all.sh", "scripts/check-all.sh"])).toEqual(["scripts/check-all.sh", "scripts/check-all.sh"]);
  });

  it("is empty when nothing needs the owner's approval", () => {
    expect(ownerApprovedFiles(["apps/server/src/app.ts", "README.md"])).toEqual([]);
    expect(ownerApprovedFiles([])).toEqual([]);
  });
});

describe("isLiveCheckWait (BOS-1636, BOS-1907)", () => {
  it("is true for a blocked or in-progress ticket with a merge commit", () => {
    expect(isLiveCheckWait({ systemState: "blocked", mergeCommit: "abc123" })).toBe(true);
    expect(isLiveCheckWait({ systemState: "in_progress", mergeCommit: "abc123" })).toBe(true);
  });

  it("is true for a blocked ticket whose checks' parent has merged", () => {
    expect(isLiveCheckWait({ systemState: "blocked", checksParentMerged: true })).toBe(true);
    expect(isLiveCheckWait({ systemState: "in_progress", mergeCommit: null, checksParentMerged: true })).toBe(true);
  });

  it("is false in review, or with no merge and no merged parent", () => {
    expect(isLiveCheckWait({ systemState: "review", mergeCommit: "abc123" })).toBe(false);
    expect(isLiveCheckWait({ systemState: "blocked" })).toBe(false);
    expect(isLiveCheckWait({ systemState: "in_progress", mergeCommit: null, checksParentMerged: null })).toBe(false);
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
