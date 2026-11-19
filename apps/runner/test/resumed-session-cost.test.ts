// BOS-1865: the agent's cost figure is cumulative for the session and carries over a reopened session. A resumed
// run must record only what it added, not the session's whole earlier total again.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-cost-acp.mjs");

function newManager(events: RunnerEvent[], waiting: Map<string, () => void>) {
  return new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH },
    adapterBins: { opencode: fake },
    resolveEnv: async (runId: string) => ({ COSTS: process.env[`COSTS_${runId}`] ?? "" }),
    emit: (e) => {
      events.push(e);
      if (e.type === "run.ended") waiting.get(e.runId)?.();
    },
  });
}

async function run(manager: SessionManager, waiting: Map<string, () => void>, runId: string, costs: string, resume: boolean) {
  process.env[`COSTS_${runId}`] = costs;
  const ended = new Promise<void>((r) => waiting.set(runId, r));
  manager.handle({
    type: "run.start", runId, agentId: "a1", agentKind: "opencode", model: null, fundingSourceId: "fs-1",
    cwd: mkdtempSync(path.join(tmpdir(), "bm-resumed-cost-")), prompt: "hi", mcpToken: "t",
    ...(resume ? { resumeSessionId: "s1" } : {}),
  } as never);
  await ended;
}

const deltas = (events: RunnerEvent[], runId: string) =>
  events.filter((e): e is Extract<RunnerEvent, { type: "run.cost" }> => e.type === "run.cost" && e.runId === runId).map((e) => e.costMicrosDelta);

describe("cost of a resumed session (BOS-1865)", () => {
  it("a resumed run records only what it added to the session's total", async () => {
    const events: RunnerEvent[] = [];
    const waiting = new Map<string, () => void>();
    const manager = newManager(events, waiting);
    await run(manager, waiting, "r1", "5", false);
    await run(manager, waiting, "r2", "7.5", true);
    await run(manager, waiting, "r3", "9", true);
    manager.shutdown();
    expect(deltas(events, "r1")).toEqual([5_000_000]);
    expect(deltas(events, "r2")).toEqual([2_500_000]);
    expect(deltas(events, "r3")).toEqual([1_500_000]);
  }, 60_000);

  it("a counter that really resets still counts from zero (R34)", async () => {
    const events: RunnerEvent[] = [];
    const waiting = new Map<string, () => void>();
    const manager = newManager(events, waiting);
    await run(manager, waiting, "r1", "5", false);
    await run(manager, waiting, "r2", "1", true);
    manager.shutdown();
    expect(deltas(events, "r2")).toEqual([1_000_000]);
  }, 60_000);

  it("a runner with no figure for the session (restarted) never records the whole history again", async () => {
    const events: RunnerEvent[] = [];
    const waiting = new Map<string, () => void>();
    const manager = newManager(events, waiting);
    await run(manager, waiting, "r1", "7.5", true);
    manager.shutdown();
    // The first figure is only a baseline.
    expect(deltas(events, "r1")).toEqual([]);
  }, 60_000);
});
