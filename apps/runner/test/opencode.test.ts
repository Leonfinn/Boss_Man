// OpenCode runs as `opencode acp`. The fake checks how the runner starts it; the gated test uses the real binary.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerEvent } from "@boss-man/shared";
import { probeModels } from "../src/models-probe.js";
import { startMcpServer, type McpCall } from "./mcp-server.js";
import { adapterArgs, defaultBin, SessionManager } from "../src/session-manager.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode.mjs");

async function run(opts: { model: string | null; boardToolsOnly?: boolean; secrets?: Record<string, string>; thinking?: string }) {
  const dump = path.join(mkdtempSync(path.join(tmpdir(), "bm-oc-")), "dump.json");
  const events: RunnerEvent[] = [];
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const manager = new SessionManager({
    mcpUrl: "http://127.0.0.1:9/mcp",
    baseEnv: { PATH: process.env.PATH, AGENT_BROWSER_ARGS: "--no-sandbox", SOME_RUNNER_ONLY_SETTING: "kept back" },
    adapterBins: { opencode: fake },
    resolveEnv: async () => ({ DUMP: dump, ...opts.secrets }),
    emit: (e) => (events.push(e), e.type === "run.ended" && done()),
  });
  manager.handle({ type: "run.start", runId: "r1", agentId: "a1", agentKind: "opencode", model: opts.model, cwd: mkdtempSync(path.join(tmpdir(), "bm-oc-ws-")), prompt: "hi", mcpToken: "t", ...(opts.boardToolsOnly ? { boardToolsOnly: true } : {}), ...(opts.thinking ? { thinking: opts.thinking } : {}) } as never);
  await ended;
  manager.shutdown();
  return { events, dump: JSON.parse(readFileSync(dump, "utf8")) };
}

describe("opencode agent kind", () => {
  it("passes the add-ons' settings through to the agent, and nothing else from the runner", async () => {
    const { dump } = await run({ model: null });
    expect(dump.browserArgs).toBe("--no-sandbox");
    expect(dump.runnerOnly).toBeNull();
  });

  it("sets the thinking level through the effort option, and leaves one the model doesn't offer at its default", async () => {
    const high = await run({ model: "b/two", thinking: "high" });
    expect(high.dump.effort).toBe("high");
    const max = await run({ model: "b/two", thinking: "max" });
    expect(max.dump.effort).toBeNull();
    expect(max.events.some((e) => e.type === "runner.log" && e.message.includes('"max" thinking level'))).toBe(true);
  });

  it("starts `opencode acp` from PATH", () => {
    expect(defaultBin("opencode")).toBe("opencode");
    expect(adapterArgs("opencode")).toEqual(["acp"]);
    expect(adapterArgs("claude")).toEqual([]);
  });

  it("passes acp, asks for approvals, keeps owner config, and selects the model", async () => {
    const { events, dump } = await run({ model: "b/two", secrets: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { x: {} }, permission: { read: "allow" } }) } });
    expect(dump.argv).toEqual(["acp"]);
    expect(dump.autoupdateOff).toBe("1");
    expect(dump.config).toMatchObject({ autoupdate: false, provider: { x: {} }, permission: { read: "allow", edit: "ask", bash: "ask", webfetch: "ask", external_directory: "ask" }, disabled_providers: ["opencode"] });
    expect(dump.model).toBe("b/two");
    expect(events.find((e) => e.type === "run.started")).toMatchObject({ model: "b/two" });
    expect(events.find((e) => e.type === "run.ended")).toMatchObject({ stopReason: "end_turn", error: null });
  });

  it("ends the run without quoting a malformed config secret", async () => {
    const events: RunnerEvent[] = [];
    let done!: () => void;
    const ended = new Promise<void>((r) => (done = r));
    const manager = new SessionManager({ mcpUrl: "http://127.0.0.1:9/mcp", baseEnv: { PATH: process.env.PATH }, adapterBins: { opencode: fake }, resolveEnv: async () => ({ OPENCODE_CONFIG_CONTENT: '{"apiKey":"sk-secret-value"' }), emit: (e) => (events.push(e), e.type === "run.ended" && done()) });
    manager.handle({ type: "run.start", runId: "r2", agentId: "a1", agentKind: "opencode", model: null, cwd: mkdtempSync(path.join(tmpdir(), "bm-oc-ws-")), prompt: "hi", mcpToken: "t" } as never);
    await ended;
    manager.shutdown();
    const end = events.find((e) => e.type === "run.ended") as { error: string };
    expect(end.error).toContain("OPENCODE_CONFIG_CONTENT isn't valid JSON");
    expect(end.error).not.toContain("sk-secret-value");
  });

  it("denies edits and commands in board-tools-only chats, and leaves the model alone when it is already selected", async () => {
    const { dump } = await run({ model: "a/one", boardToolsOnly: true });
    expect(dump.config.permission).toMatchObject({ edit: "deny", bash: "deny", webfetch: "deny" });
    expect(dump.model).toBeNull();
  });
});

// Real binary: OPENCODE_BIN=/path/to/opencode pnpm test. Offline; the key is a dummy that only makes the provider appear.
describe.skipIf(!process.env.OPENCODE_BIN || !existsSync(process.env.OPENCODE_BIN))("real opencode acp", () => {
  it("handshakes and lists provider/model ids", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bm-oc-home-"));
    const models = await probeModels("opencode", { OPENROUTER_API_KEY: "sk-or-dummy" }, { adapterBin: process.env.OPENCODE_BIN, baseEnv: { PATH: process.env.PATH, HOME: home }, timeoutMs: 60_000 });
    expect(models.some((m) => m.value.startsWith("openrouter/"))).toBe(true);
  }, 90_000);
});

// A scripted OpenAI-format model: asks for the given tool once, then answers "done".
function stubModel(tool: string, args: Record<string, unknown>) {
  const server = http.createServer((q, r) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", () => {
      const done = (JSON.parse(b || "{}").messages ?? []).some((m: { role: string }) => m.role === "tool");
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      r.writeHead(200, { "content-type": "text/event-stream" });
      r.write(done ? chunk({ role: "assistant", content: "done" }) + chunk({}, "stop") : chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }) + chunk({}, "tool_calls"));
      r.end("data: [DONE]\n\n");
    });
  });
  return new Promise<{ url: string; close: () => void }>((res) => server.listen(0, "127.0.0.1", () => res({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => server.close() })));
}

describe.skipIf(!process.env.OPENCODE_BIN || !existsSync(process.env.OPENCODE_BIN))("real opencode run", () => {
  const ocRun = async (tool: string, args: Record<string, unknown>) => {
    const model = await stubModel(tool, args);
    const calls: McpCall[] = [];
    const mcp = await startMcpServer(calls);
    const home = mkdtempSync(path.join(tmpdir(), "bm-oc-home-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "bm-oc-ws-"));
    const config = { provider: { stub: { npm: "@ai-sdk/openai-compatible", name: "Stub", options: { baseURL: model.url, apiKey: "k" }, models: { m1: { name: "M1", tool_call: true, limit: { context: 8000, output: 1000 } } } } } };
    const events: RunnerEvent[] = [];
    let done!: () => void;
    const ended = new Promise<void>((r) => (done = r));
    const manager: SessionManager = new SessionManager({
      mcpUrl: mcp.url,
      baseEnv: { PATH: process.env.PATH, HOME: home },
      adapterBins: { opencode: process.env.OPENCODE_BIN! },
      resolveEnv: async () => ({ OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }),
      emit: (e) => {
        events.push(e);
        if (e.type === "run.permission_request") manager.handle({ type: "permission.decide", runId: e.runId, requestId: e.requestId, verdict: "deny" });
        if (e.type === "run.ended") done();
      },
    });
    manager.handle({ type: "run.start", runId: "r1", agentId: "a1", agentKind: "opencode", model: "stub/m1", cwd, prompt: "go", mcpToken: "bm_sess_test" } as never);
    await ended;
    manager.shutdown();
    model.close();
    await mcp.close();
    return { events, calls, cwd };
  };

  it("sends shell commands to Boss Man for a verdict, and a denial stops them", async () => {
    const { events, cwd } = await ocRun("bash", { command: "echo hi > out.txt", description: "write" });
    expect(events.find((e) => e.type === "run.permission_request")).toMatchObject({ kind: "execute", rawInput: { command: "echo hi > out.txt" } });
    expect(existsSync(path.join(cwd, "out.txt"))).toBe(false);
  }, 90_000);

  it("reaches the Boss Man MCP server with the session token", async () => {
    const { events, calls } = await ocRun("bossman_create_ticket", { title: "from opencode" });
    expect(calls).toEqual([{ tool: "create_ticket", token: "bm_sess_test", args: { title: "from opencode" } }]);
    expect(events.find((e) => e.type === "run.ended")).toMatchObject({ stopReason: "end_turn" });
  }, 90_000);
});
