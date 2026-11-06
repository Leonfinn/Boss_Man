// BOS-552: a run that needs the Boss Man tools must not start when it can't reach them. OpenCode's
// session/new succeeds even against a dead server and then runs blind, so the runner checks first.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { checkBossManTools, SessionManager } from "../src/session-manager.js";
import { startMcpServer } from "./mcp-server.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode.mjs");

type Check = (url: string, token: string) => Promise<{ ok: boolean; tools?: string[]; reason?: string }>;

async function run(opts: { mcpRequired?: boolean; caps?: object; mcpUrl?: string; check?: Check }) {
  const events: RunnerEvent[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager = new SessionManager({
    mcpUrl: opts.mcpUrl ?? "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH },
    adapterBins: { opencode: fake },
    ...(opts.check ? { checkBossManTools: opts.check } : {}),
    resolveEnv: async () => ({ DUMP: path.join(mkdtempSync(path.join(tmpdir(), "bm-pf-")), "dump.json"), MCP_CAPS: JSON.stringify(opts.caps ?? { http: true, sse: true }) }),
    emit: (e) => (events.push(e), e.type === "run.ended" && done()),
  });
  manager.handle({ type: "run.start", runId: "r1", agentId: "a1", agentKind: "opencode", model: null, cwd: mkdtempSync(path.join(tmpdir(), "bm-pf-ws-")), prompt: "hi", mcpToken: "t", ...(opts.mcpRequired === undefined ? {} : { mcpRequired: opts.mcpRequired }) } as never);
  await ended;
  manager.shutdown();
  return events;
}

describe("Boss Man tools preflight (BOS-552)", () => {
  it("stops an mcpRequired run, visibly, when the tools can't be reached: no blind run", async () => {
    const events = await run({ mcpRequired: true, check: async () => ({ ok: false, reason: "connection refused" }) });
    const ended = events.find((e) => e.type === "run.ended") as { error: string | null };
    expect(ended.error).toContain("couldn't reach the Boss Man tools");
    expect(ended.error).toContain("connection refused");
    expect(events.find((e) => e.type === "run.started")).toBeUndefined();
  });

  it("starts an mcpRequired run when the tools answer", async () => {
    const events = await run({ mcpRequired: true, check: async () => ({ ok: true, tools: ["create_ticket"] }) });
    expect(events.find((e) => e.type === "run.started")).toBeDefined();
    expect((events.find((e) => e.type === "run.ended") as { error: string | null }).error).toBeNull();
  });

  it("retries a moment-late server instead of failing the run at once", async () => {
    let calls = 0;
    const events = await run({ mcpRequired: true, check: async () => (++calls === 1 ? { ok: false, reason: "timed out" } : { ok: true, tools: ["x"] }) });
    expect(calls).toBe(2);
    expect(events.find((e) => e.type === "run.started")).toBeDefined();
  });

  it("stops an mcpRequired run loudly when the agent can't use HTTP MCP at all", async () => {
    const events = await run({ mcpRequired: true, caps: { sse: true }, check: async () => ({ ok: true, tools: ["x"] }) });
    const ended = events.find((e) => e.type === "run.ended") as { error: string | null };
    expect(ended.error).toContain("doesn't support HTTP MCP");
    expect(events.find((e) => e.type === "run.started")).toBeUndefined();
  });

  it("leaves runs that don't require the tools as they were", async () => {
    let called = false;
    const events = await run({ check: async () => ((called = true), { ok: false, reason: "refused" }) });
    expect(called).toBe(false);
    expect(events.find((e) => e.type === "run.started")).toBeDefined();
    expect((events.find((e) => e.type === "run.ended") as { error: string | null }).error).toBeNull();
  });

  it("the real check lists tools from a healthy server and rejects an unreachable one", async () => {
    const mcp = await startMcpServer([]);
    try {
      const ok = await checkBossManTools(mcp.url, "bm_sess_test");
      expect(ok.ok).toBe(true);
      expect(ok.tools).toContain("create_ticket");
    } finally {
      await mcp.close();
    }
    const bad = await checkBossManTools("http://127.0.0.1:9/mcp", "t");
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBeTruthy();
  });
});
