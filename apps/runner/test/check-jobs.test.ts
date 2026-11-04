import { describe, expect, it } from "vitest";
import type { RunnerMessage } from "@boss-man/shared";
import { CheckJobs } from "../src/check-jobs.js";

const J = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";

function fake() {
  const sent: RunnerMessage[] = [];
  let finish!: (r: { ok: boolean; exitCode: number | null; timedOut: boolean; output: string; ms: number }) => void;
  let kill: (() => void) | undefined;
  const ws = {
    runCommitCheck: (_s: unknown, _c: string, _t: number, hooks: { onStart?: (k: () => void) => void; onOutput?: (t: string) => void }) => {
      hooks.onStart?.(() => { kill?.(); finish({ ok: false, exitCode: null, timedOut: true, output: "partial", ms: 1 }); });
      hooks.onOutput?.("first line");
      return new Promise<never>((resolve) => { finish = resolve as never; });
    },
  };
  const jobs = new CheckJobs(ws as never, (m) => sent.push(m));
  return { jobs, sent, finish: (r: Parameters<typeof finish>[0]) => finish(r) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("CheckJobs", () => {
  it("runs a job, reports it done with the commit, and keeps the result until acknowledged", async () => {
    const f = fake();
    f.jobs.run({ jobId: J, projectId: P, commit: "abc1234", command: "x" });
    expect(f.jobs.running()).toEqual([J]);
    f.finish({ ok: true, exitCode: 0, timedOut: false, output: "all green", ms: 5 });
    await tick();
    expect(f.jobs.running()).toEqual([]);
    expect(f.sent.find((m) => m.type === "check.done")).toMatchObject({ jobId: J, commit: "abc1234", exitCode: 0, timedOut: false, tail: "all green" });
    f.sent.length = 0;
    f.jobs.resend();
    expect(f.sent).toHaveLength(1);
    f.jobs.acknowledge(J);
    f.sent.length = 0;
    f.jobs.resend();
    expect(f.sent).toHaveLength(0);
  });

  it("a second check.run for the same job does not start it twice", () => {
    const f = fake();
    f.jobs.run({ jobId: J, projectId: P, commit: "abc1234", command: "x" });
    f.jobs.run({ jobId: J, projectId: P, commit: "abc1234", command: "x" });
    expect(f.jobs.running()).toEqual([J]);
  });

  it("a cancel from the server stops the job and says so, not a timeout", async () => {
    const f = fake();
    f.jobs.run({ jobId: J, projectId: P, commit: "abc1234", command: "x" });
    f.jobs.cancel(J);
    await tick();
    const done = f.sent.find((m) => m.type === "check.done") as Extract<RunnerMessage, { type: "check.done" }>;
    expect(done.timedOut).toBe(false);
    expect(done.exitCode).toBeNull();
    expect(done.tail).toContain("Stopped by the server");
  });
});
