// Spike S4 (R42): can a Claude session resume after the adapter dies mid-tool-call?
// Kills claude-agent-acp while a Bash call waits for permission, then starts a new
// adapter on the same config dir and tries session/load and session/resume. The stub
// model rejects dangling tool_use blocks the way the real API does.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { startStubAnthropic, type StubLogEntry } from "./stub-model.js";
import { claudeAdapterBin } from "./claude-adapter.js";

// The adapter lives in the Claude pack now (DR-050, BOS-972), not the runner's node_modules; this spike
// only runs on request, so it looks the adapter up when it runs, never at import.
const BIN = process.env.RUN_SPIKES === "1" ? (claudeAdapterBin() ?? "claude-agent-acp") : "";

let stub: Awaited<ReturnType<typeof startStubAnthropic>>;
const log: StubLogEntry[] = [];
const children: ChildProcess[] = [];
beforeEach(async () => {
  log.length = 0;
  stub = await startStubAnthropic(log);
});
afterEach(async () => {
  for (const c of children) {
    try {
      process.kill(-c.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await stub.close();
});

function adapter(home: string, cwd: string, onPermission: (title: string) => boolean) {
  const child = spawn(BIN, [], {
    cwd,
    // Its own process group, so a "crash" can take down Claude Code too, as a container crash would.
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: "sk-ant-stub-not-a-real-key", NO_PROXY: "127.0.0.1,localhost", DISABLE_AUTOUPDATER: "1" },
  });
  children.push(child);
  child.stderr?.resume();
  const updates: string[] = [];
  const conn = acpClient({ name: "s4" })
    .onNotification(methods.client.session.update, (ctx) => void updates.push((ctx.params as { update: { sessionUpdate: string } }).update.sessionUpdate))
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      const p = ctx.params as { toolCall?: { title?: string }; options: Array<{ kind: string; optionId: string }> };
      const crashHere = onPermission(String(p.toolCall?.title ?? ""));
      // Earlier calls are allowed; at the crash point the call is never answered.
      if (!crashHere) return { outcome: { outcome: "selected", optionId: p.options.find((o) => o.kind === "allow_once")!.optionId } } as never;
      return new Promise(() => {}) as never;
    })
    .connect(ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>));
  return { child, agent: conn.agent, updates };
}

/** Crashes while the Nth permission request (1-based) is pending. */
async function crashMidToolCall(atRequest: number) {
  const home = mkdtempSync(path.join(tmpdir(), "bm-s4-home-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "bm-s4-ws-"));
  let crashed!: (title: string) => void;
  const atPermission = new Promise<string>((r) => (crashed = r));
  let seen = 0;
  const a = adapter(home, cwd, (title) => {
    if (++seen < atRequest) return false;
    crashed(title);
    return true;
  });
  await a.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const session = await a.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
  void a.agent.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: "Run the spike scenario." }] }).catch(() => {});
  const pendingTool = await atPermission;
  // Take down the adapter and Claude Code together while the call waits, as a container crash would.
  process.kill(-a.child.pid!, "SIGKILL");
  await new Promise((r) => a.child.once("exit", r));
  return { home, cwd, sessionId: session.sessionId, pendingTool };
}

async function reopen(home: string, cwd: string) {
  const b = adapter(home, cwd, () => false);
  const init = await b.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  return { ...b, init };
}

// A spike, not a gate: it depends on when Claude Code flushes its transcript, so it runs
// only on request (RUN_SPIKES=1). Findings are in spikes/s4-resume/README.md.
describe.runIf(process.env.RUN_SPIKES === "1")("spike S4: resume after a crash mid-tool-call", () => {
  async function continueAfterLoad(atRequest: number) {
    const { home, cwd, sessionId, pendingTool } = await crashMidToolCall(atRequest);
    const b = await reopen(home, cwd);
    expect((b.init.agentCapabilities as { loadSession?: boolean }).loadSession).toBe(true);
    const loaded = await b.agent
      .request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] })
      .then(() => null)
      .catch((err: unknown) => String((err as Error)?.message ?? err));
    if (loaded) return { pendingTool, loadError: loaded };
    const before = log.length;
    const result = await b.agent
      .request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "You were interrupted by a crash. Continue where you left off." }] })
      .then((r) => ({ ok: true as const, stopReason: r.stopReason }))
      .catch((err: unknown) => ({ ok: false as const, error: String((err as Error)?.message ?? err) }));
    const after = log.slice(before).filter((l) => l.hasTools || l.step === "rejected-dangling-tool-use");
    return { pendingTool, loadError: null, result, after };
  }

  it("a crash before Claude Code writes its transcript loses the session: load says not found", async () => {
    const r = await continueAfterLoad(1);
    expect(r.pendingTool).toBe("echo spike > spike.txt");
    expect(r.loadError).toMatch(/Resource not found/);
  }, 90_000);

  it("a later crash resumes cleanly, but steps after the last flush are repeated", async () => {
    const r = await continueAfterLoad(2);
    expect(r.pendingTool).toBe("rm -rf /srv/precious");
    expect(r.loadError).toBeNull();
    expect(r.result).toMatchObject({ ok: true, stopReason: "end_turn" });
    // The dangling tool call never reaches the model...
    expect(r.after!.some((l) => l.step === "rejected-dangling-tool-use")).toBe(false);
    // ...but the MCP call that ran before the crash runs again after it.
    expect(r.after!.map((l) => l.step)).toContain("mcp-create-ticket");
  }, 90_000);
});
