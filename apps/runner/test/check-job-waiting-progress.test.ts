// BOS-805 (QA, BOS-826): what a server-queued check job reports to the server while it waits for, or holds, a runner check slot.
// The progress message names the wait so the owner's Checks page does not show a job that is merely queued as stuck.
import { describe, expect, it } from "vitest";
import { CHECK_QUEUED_MARKER, CHECK_STARTED_MARKER, type RunnerMessage } from "@boss-man/shared";
import { CheckJobs } from "../src/check-jobs.js";

const J = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";

/** Runs one job whose command prints `output` once, and returns the progress messages sent. */
function progressFor(output: string) {
  const sent: RunnerMessage[] = [];
  const ws = {
    runCommitCheck: (_s: unknown, _c: string, _t: number, hooks: { onOutput?: (t: string) => void }) => {
      hooks.onOutput?.(output);
      return new Promise<never>(() => {});
    },
  };
  new CheckJobs(ws as never, (m) => sent.push(m)).run({ jobId: J, projectId: P, commit: "abc1234", command: "x" });
  return sent.filter((m): m is Extract<RunnerMessage, { type: "check.progress" }> => m.type === "check.progress");
}

describe("check job progress while in the runner's check line (BOS-805)", () => {
  it("says it is waiting for a runner check slot while the queue line is the last marker", () => {
    const [p] = progressFor(`pnpm install\n${CHECK_QUEUED_MARKER} (place 2)\n`);
    expect(p!.tail.startsWith("waiting for a runner check slot\n")).toBe(true);
    expect(p!.tail).toContain(CHECK_QUEUED_MARKER);
  });

  it("is plain output once the slot is taken after the wait", () => {
    const out = `${CHECK_QUEUED_MARKER}\n${CHECK_STARTED_MARKER}\nrunning vitest\n`;
    const [p] = progressFor(out);
    expect(p!.tail).toBe(out);
  });

  it("is plain output for a job that never queued", () => {
    const [p] = progressFor("just output\n");
    expect(p!.tail).toBe("just output\n");
  });

  it("waits again when it queues a second time after a first slot (the last marker wins)", () => {
    const [p] = progressFor(`${CHECK_QUEUED_MARKER}\n${CHECK_STARTED_MARKER}\n${CHECK_QUEUED_MARKER}\n`);
    expect(p!.tail.startsWith("waiting for a runner check slot\n")).toBe(true);
  });

  it("keeps the progress tail within 8192 characters even with the waiting prefix", () => {
    const [p] = progressFor(`${"x".repeat(9000)}\n${CHECK_QUEUED_MARKER}\n`);
    expect(p!.tail.length).toBeLessThanOrEqual(8192);
    expect(p!.tail).toContain(CHECK_QUEUED_MARKER);
  });
});
