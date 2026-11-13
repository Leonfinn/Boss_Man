// BOS-1016: a run.message with steer goes into the running turn when the agent supports ACP steering,
// and otherwise (no steering, the adapter says promptRequired, or it fails) waits for the turn as before.
// It is never delivered twice. The real Claude Code case is in session-manager.test.ts.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-steer-acp.mjs");

async function run(mode: "none" | "injected" | "promptRequired" | "error", message: { steer?: boolean; interrupt?: boolean } = { steer: true }) {
  const dump = path.join(mkdtempSync(path.join(tmpdir(), "bm-steer-")), "calls.jsonl");
  const events: RunnerEvent[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  let manager!: SessionManager;
  manager = new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH },
    adapterBins: { opencode: fake },
    resolveEnv: async () => ({ DUMP: dump, FAKE_STEER: mode }),
    emit: (e) => {
      events.push(e);
      // The message arrives while the first turn (800 ms, starting just after run.started) is running.
      if (e.type === "run.started") setTimeout(() => manager.handle({ type: "run.message", runId: "run-steer", text: "Please wrap up.", interrupt: message.interrupt ?? false, ...(message.steer === undefined ? {} : { steer: message.steer }) } as never), 300);
      if (e.type === "run.ended") done();
    },
  });
  manager.handle({ type: "run.start", runId: "run-steer", agentId: "a1", agentKind: "opencode", model: null, cwd: mkdtempSync(path.join(tmpdir(), "bm-steer-ws-")), prompt: "Work.", mcpToken: "t" } as never);
  await ended;
  manager.shutdown();
  const calls = existsSync(dump) ? readFileSync(dump, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; text: string; meta?: unknown }) : [];
  const delivered = events.filter((e) => e.type === "run.update" && (e.update as { kind?: string }).kind === "message_delivered").map((e) => (e as { update: Record<string, unknown> }).update);
  return { calls, delivered, ended: events.find((e) => e.type === "run.ended") };
}

describe("steering a message into a running turn (BOS-1016)", () => {
  it("an agent that supports steering gets the message in the running turn, once, with no second prompt", async () => {
    const r = await run("injected");
    expect(r.calls.map((c) => c.method)).toEqual(["session/prompt", "_session/steering"]);
    expect(r.calls[1]).toMatchObject({ text: "Please wrap up.", meta: { steering: { idleBehavior: "promptRequired" } } });
    expect(r.delivered).toEqual([{ kind: "message_delivered", text: "Please wrap up.", fullLength: 15, steered: true }]);
    expect(r.ended).toMatchObject({ stopReason: "end_turn", error: null });
  }, 30_000);

  it("an agent without steering gets it as the next prompt, as before", async () => {
    const r = await run("none");
    expect(r.calls.map((c) => c.method)).toEqual(["session/prompt", "session/prompt"]);
    expect(r.calls[1]!.text).toBe("Please wrap up.");
    expect(r.delivered).toEqual([{ kind: "message_delivered", text: "Please wrap up.", fullLength: 15 }]);
  }, 30_000);

  it.each(["promptRequired", "error"] as const)("when the adapter answers %s, the message waits for the turn and is delivered once", async (mode) => {
    const r = await run(mode);
    expect(r.calls.map((c) => c.method)).toEqual(["session/prompt", "_session/steering", "session/prompt"]);
    expect(r.calls[2]!.text).toBe("Please wrap up.");
    expect(r.delivered).toHaveLength(1);
    expect(r.delivered[0]).not.toHaveProperty("steered");
    expect(r.ended).toMatchObject({ stopReason: "end_turn", error: null });
  }, 30_000);

  it("a message without steer is queued even when the agent could steer (owner chat keeps its behaviour)", async () => {
    const r = await run("injected", {});
    expect(r.calls.map((c) => c.method)).toEqual(["session/prompt", "session/prompt"]);
    expect(r.delivered).toHaveLength(1);
  }, 30_000);
});
