// BOS-1435 (DR-060): the runner image as a check worker. It acts on check commands only, puts only bounded per-check caps
// into a job's environment, dials only the worker socket, and reads its token from a file, never the environment.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunnerCommand } from "@boss-man/shared";
import { checkLimitsEnv } from "../src/check-jobs.js";
import { workerHandles, workerUrl } from "../src/check-worker.js";
import { safeWorkerToken } from "../src/token.js";

const JOB = "00000000-0000-4000-8000-000000000001";

describe("check worker role (BOS-1435)", () => {
  it("acts on check.run, check.cancel and check.ack only", () => {
    const calls: string[] = [];
    const jobs = { run: () => void calls.push("run"), cancel: () => void calls.push("cancel"), acknowledge: () => void calls.push("ack") };
    expect(workerHandles({ type: "check.run", jobId: JOB, projectId: JOB, ticketId: JOB, commit: "abcdef1", command: "scripts/check-quick.sh" }, jobs)).toBe(true);
    expect(workerHandles({ type: "check.cancel", jobId: JOB }, jobs)).toBe(true);
    expect(workerHandles({ type: "check.ack", jobId: JOB }, jobs)).toBe(true);
    expect(workerHandles({ type: "run.cancel", runId: JOB } as RunnerCommand, jobs)).toBe(false);
    expect(workerHandles({ type: "credential.check", requestId: "r" } as RunnerCommand, jobs)).toBe(false);
    expect(calls).toEqual(["run", "cancel", "ack"]);
  });

  it("turns the per-check caps into the job's environment, and drops anything out of range or unknown", () => {
    expect(checkLimitsEnv({ threads: 4, memoryMb: 14336 })).toEqual({ BOSSMAN_CHECK_THREADS: "4", BOSSMAN_CHECK_MEMORY_MB: "14336" });
    expect(checkLimitsEnv({ threads: 2 })).toEqual({ BOSSMAN_CHECK_THREADS: "2" });
    expect(checkLimitsEnv(undefined)).toEqual({});
    expect(checkLimitsEnv({ threads: 0 })).toEqual({});
    expect(checkLimitsEnv({ threads: 1.5 })).toEqual({});
    expect(checkLimitsEnv({ memoryMb: 10 })).toEqual({});
    expect(checkLimitsEnv({ threads: "4; rm -rf /" })).toEqual({});
    // Unknown keys never become variables.
    expect(checkLimitsEnv({ threads: 2, LD_PRELOAD: "/tmp/x.so" })).toEqual({ BOSSMAN_CHECK_THREADS: "2" });
  });

  it("dials only the check worker socket", () => {
    expect(workerUrl("wss://bossman.example.com/api/check-worker/connect")).toBe("wss://bossman.example.com/api/check-worker/connect");
    expect(() => workerUrl("wss://bossman.example.com/api/runner/connect")).toThrow(/check-worker\/connect/);
    expect(() => workerUrl(undefined)).toThrow();
  });

  it("reads its token from a file and refuses one in the environment", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bm-worker-token-"));
    const file = path.join(dir, "token");
    writeFileSync(file, "bmw_example\n");
    expect(safeWorkerToken({ BOSSMAN_CHECK_WORKER_TOKEN_FILE: file })).toBe("bmw_example");
    const env: NodeJS.ProcessEnv = { BOSSMAN_CHECK_WORKER_TOKEN: "bmw_plain", BOSSMAN_CHECK_WORKER_TOKEN_FILE: file };
    expect(() => safeWorkerToken(env)).toThrow(/environment/);
    expect(env.BOSSMAN_CHECK_WORKER_TOKEN).toBeUndefined();
    expect(() => safeWorkerToken({})).toThrow(/BOSSMAN_CHECK_WORKER_TOKEN_FILE/);
  });

  it("main.ts hands over to the check worker before any runner start-up when BOSSMAN_ROLE=check-worker", () => {
    const main = readFileSync(path.join(import.meta.dirname, "..", "src", "main.ts"), "utf8");
    const guard = main.indexOf('process.env.BOSSMAN_ROLE === "check-worker"');
    expect(guard).toBeGreaterThan(-1);
    // Nothing that fetches secrets, starts sessions or reads the runner token runs before the hand-over.
    for (const later of ["safeRunnerToken(env)", "new SessionManager(", "/api/runner/env", "new Journal("]) expect(main.indexOf(later)).toBeGreaterThan(guard);
  });
});
