// BOS-2058: the guard. A new hold or wait can't come back without an end and a reason on screen, because:
//  1. every WaitKind has a rule (WAIT_RULES is a Record, so a missing one fails typecheck; this test reads the union's text
//     as well, so a kind added to the union and a rule added by a `as` cast still fails);
//  2. the files that decide whether new work may start while an update holds (the hold readers) are a short, named list.
//     A new file that reads a hold to hold work back is a wait nobody wrote a rule for: this test names it and says what to do.
// It reads repo files by path, so the merge gate runs it (whole-repo test).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ruleProblems, WAIT_RULES, type WaitKind } from "../src/services/update-waits.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));

describe("update waits guard (BOS-2058)", () => {
  it("every kind in the WaitKind union has a rule with an end, an earlier CEO wake and words", () => {
    const text = readFileSync(path.join(SRC, "services/update-waits.ts"), "utf8");
    const union = /export type WaitKind =([^;]+);/.exec(text)![1]!;
    const kinds = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(10);
    expect(Object.keys(WAIT_RULES).sort()).toEqual([...kinds].sort());
    expect(kinds.flatMap((k) => ruleProblems(k as WaitKind))).toEqual([]);
  });

  // The readers of the two holds (the server update's soft hold, the runner update's maintenance hold) that decide whether
  // work may start. Today's list; the ratchet only shrinks. A file not here that calls one of these is a new wait.
  const READERS = [
    "app.ts",
    "main.ts",
    "mcp-tickets.ts",
    "routes/settings-limits.ts",
    "services/brief.ts",
    "services/check-gate.ts",
    "services/check-queue.ts",
    "services/deploy-wait-hold.ts",
    "services/deploy-wait.ts",
    "services/maintenance.ts",
    "services/merge-queue.ts",
    "services/merge-status.ts", // landingMergeIds (moved out of review.ts, BOS-1904): the runner-landing row's live count
    "services/review.ts", // landingMergeIds: the runner-landing row's live count (landingsThatCount)
    "services/runner-report.ts",
    "services/scheduler.ts",
    "services/self-deploy.ts",
    "services/sweeps.ts",
    "services/update-waits.ts",
    "services/watchdog.ts",
  ];
  it("only the known files read an update hold to hold work back", () => {
    const found = walk(SRC)
      .filter((f) => /\b(softHold|holdBlocksStarts|getHold|landingMergeIds)\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .sort();
    const extra = found.filter((f) => !READERS.includes(f));
    expect(
      extra,
      `${extra.join(", ")} reads an update hold (softHold, holdBlocksStarts, getHold or landingMergeIds). A wait that holds work back needs a kind in WAIT_RULES (apps/server/src/services/update-waits.ts) with its own end, its CEO wake and its words for the screen. Add the kind, call blocksClass() for what it stops, then add the file to READERS here.`,
    ).toEqual([]);
  });
});
