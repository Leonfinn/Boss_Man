// BOS-552: a run that needs the Boss Man tools must not start when it can't reach them. OpenCode's
// session/new succeeds even against a dead server and then runs blind, so the runner checks first.
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { SessionManager } from "../src/session-manager.js";
import { checkBossManTools } from "../src/mcp-preflight.js";
import { startMcpServer } from "./mcp-server.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode.mjs");

type Check = (url: string, token: string) => Promise<{ ok: boolean; tools?: string[]; reason?: string }>;

async function run(opts: { mcpRequired?: boolean; caps?: object; mcpUrl?: string; check?: Check; preflightMs?: number; fast?: boolean }) {
  const events: RunnerEvent[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager = new SessionManager({
    mcpUrl: opts.mcpUrl ?? "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH },
    adapterBins: { opencode: fake },
    ...(opts.check ? { checkBossManTools: opts.check } : {}),
    // BOS-664: short timers by default; the real-timing case below runs with `fast: false` (the production 30 s budget, 2 s delay).
    ...(opts.fast ? { mcpRequiredPreflight: { budgetMs: 600, attemptTimeoutMs: 100, delayMs: 50 } } : {}),
    ...(opts.preflightMs ? { mcpPreflightMs: opts.preflightMs, mcpPreflightTuning: { attemptTimeoutMs: 100, delayMs: 50 } } : {}),
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

  it("without an injected check, a dead server stops the run loudly (real preflight + tools check)", async () => {
    const events = await run({ mcpRequired: true, mcpUrl: "http://127.0.0.1:9/mcp", fast: true });
    const ended = events.find((e) => e.type === "run.ended") as { error: string | null };
    expect(ended.error).toContain("couldn't reach the Boss Man tools");
    expect(events.find((e) => e.type === "run.started")).toBeUndefined();
  }, 15_000);

  // The one real-timing case (BOS-664): production timers, a server that is stalled for ~2.5 s and then answers. It
  // proves the default 30 s budget and 2 s retry delay really outlast a short stall (BOS-428) without a 28 s wait.
  it("with the production timers, a server that is down for a couple of seconds still gets the run started", async () => {
    const mcp = await startMcpServer([]);
    const opensAt = Date.now() + 2500;
    const upstream: http.ClientRequest[] = [];
    const front = http.createServer((req, res) => {
      if (Date.now() < opensAt) {
        req.resume();
        res.writeHead(503).end();
        return;
      }
      const up = http.request(mcp.url, { method: req.method, headers: req.headers, agent: false }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      upstream.push(up);
      req.pipe(up);
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(front.address() as { port: number }).port}/mcp`;
      const events = await run({ mcpRequired: true, mcpUrl: url });
      expect((events.find((e) => e.type === "run.ended") as { error: string | null }).error).toBeNull();
      expect(events.find((e) => e.type === "run.started")).toBeDefined();
    } finally {
      for (const u of upstream) u.destroy();
      front.closeAllConnections();
      await new Promise((r) => front.close(r));
      await mcp.close();
    }
  }, 30_000);

  it("tells the owner and the server log before retrying once, then stops the run (BOS-403 + BOS-552)", async () => {
    const events = await run({ mcpRequired: true, mcpUrl: "http://127.0.0.1:9/mcp", preflightMs: 300 });
    const said = events.filter((e) => e.type === "run.update").map((e) => (e as { update: { text?: string } }).update.text);
    expect(said).toContain("Boss Man tools didn't load, retrying.");
    const logs = events.filter((e) => e.type === "runner.log").map((e) => e as { level: string; message: string }).filter((l) => l.message.startsWith("mcp-preflight:"));
    expect(logs.map((l) => l.level)).toEqual(["warn", "error"]);
    expect((events.find((e) => e.type === "run.ended") as { error: string | null }).error).toContain("couldn't reach the Boss Man tools");
    expect(events.find((e) => e.type === "run.started")).toBeUndefined();
  }, 30_000);

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
