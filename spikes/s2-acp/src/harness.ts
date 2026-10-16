// Spike S2 harness: acts as the Boss Man runner daemon's ACP client.
//
//   tsx src/harness.ts --agent claude --sessions 3           # stub model, no credentials
//   tsx src/harness.ts --agent claude --sessions 3 --real    # your credentials from env
//
// Stub mode starts a scripted Anthropic Messages API on localhost and scrubs
// the environment, so no real credentials are used or needed.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import { startStubAnthropic, type StubLogEntry } from "./stub-anthropic.js";
import { startMcpServer, newSessionToken, type McpCall } from "./mcp-server.js";
import { decide, toResponse, type PolicyDecision } from "./policy.js";

const argv = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const AGENT = arg("agent", "claude") as "claude" | "codex";
const SESSIONS = Number(arg("sessions", "3"));
const REAL = argv.includes("--real");
// R8 fallback: pin a model the agent does not list, at launch time (env/config), not via ACP.
const PIN_MODEL = arg("pin-model", "");
const TIMEOUT_MS = Number(arg("timeout", REAL ? "300000" : "120000"));
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = (name: string) => path.resolve(here, "..", "node_modules", ".bin", name);

const STUB_PROMPT = "Run the spike scenario.";
const REAL_PROMPT = [
  "This is an automated integration test of a tool harness. Do exactly these steps, one tool call each:",
  "1. Run the shell command: echo spike > spike.txt",
  "2. Call the bossman create_ticket tool with title 'Spike S2 real run'.",
  "3. Run the shell command: rm -rf /srv/precious  (the harness will deny it; that is expected).",
  "Then reply with the single word SPIKE_DONE.",
].join("\n");

function childEnv(stubUrl: string | undefined, home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: "C.UTF-8",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (process.env.CLAUDE_CODE_EXECUTABLE) base.CLAUDE_CODE_EXECUTABLE = process.env.CLAUDE_CODE_EXECUTABLE;
  // Codex's default "agent" mode routes approvals to its own AI reviewer ("Guardian").
  // workspace-write routes them to the ACP client, where Boss Man's policy engine answers.
  base.INITIAL_AGENT_MODE = process.env.INITIAL_AGENT_MODE ?? "workspace-write";
  if (!REAL) {
    // Stub mode: point every client at the local stub, with obviously fake keys.
    return {
      ...base,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CODEX_HOME: path.join(home, ".codex"),
      ANTHROPIC_BASE_URL: stubUrl,
      ANTHROPIC_API_KEY: "sk-ant-stub-not-a-real-key",
      OPENAI_BASE_URL: `${stubUrl}/v1`,
      OPENAI_API_KEY: "sk-stub-not-a-real-key",
      CODEX_API_KEY: "sk-stub-not-a-real-key",
      ...(PIN_MODEL && AGENT === "claude" ? { ANTHROPIC_DEFAULT_OPUS_MODEL: PIN_MODEL } : {}),
      CODEX_CONFIG: JSON.stringify({
        ...(PIN_MODEL && AGENT === "codex" ? { model: PIN_MODEL } : {}),
        model_provider: "bmstub",
        model_providers: { bmstub: { name: "bmstub", base_url: `${stubUrl}/v1`, env_key: "OPENAI_API_KEY", wire_api: "responses" } },
      }),
    };
  }
  // Real mode: pass through only the credentials Boss Man would inject from its secrets store.
  const pass = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "HTTPS_PROXY", "HTTP_PROXY", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
  for (const k of pass) if (process.env[k]) base[k] = process.env[k];
  return base;
}

type SessionReport = {
  index: number;
  sessionId?: string;
  token: string;
  cwd: string;
  configOptions: { id: string; name: string; category?: string | null; values: string[]; current: unknown }[];
  freeTextModel?: { tried: string; ok: boolean; error?: string };
  stopReason?: string;
  error?: string;
  toolCalls: { title?: string | null; kind?: string | null; status?: string | null; rawOutput?: string }[];
  usageUpdates: unknown[];
  otherUpdates: Record<string, number>;
  markerFile: boolean;
  ms?: number;
  agentText?: string;
};

function flattenOptions(opt: SessionConfigOption): string[] {
  if (opt.type !== "select") return [];
  const out: string[] = [];
  for (const o of opt.options as any[]) {
    if (o && Array.isArray(o.options)) for (const g of o.options) out.push(g.value);
    else if (o && "value" in o) out.push(o.value);
  }
  return out;
}

async function main() {
  const stubLog: StubLogEntry[] = [];
  const mcpCalls: McpCall[] = [];
  const decisions: PolicyDecision[] = [];
  const stub = REAL ? undefined : await startStubAnthropic(stubLog);
  const mcp = await startMcpServer(mcpCalls);
  const root = mkdtempSync(path.join(tmpdir(), `bm-s2-${AGENT}-`));
  const home = path.join(root, "home");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });

  const command = AGENT === "claude" ? bin("claude-agent-acp") : bin("codex-acp");
  const child: ChildProcess = spawn(command, [], { env: childEnv(stub?.url, home), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));

  const sessions = new Map<string, SessionReport>();
  const connection = acpClient({ name: "boss-man-runner-spike" })
    .onNotification(methods.client.session.update, (ctx) => {
      const n = ctx.params as SessionNotification;
      const s = sessions.get(n.sessionId);
      if (!s) return;
      const u: any = n.update;
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        if (u.status === "completed" || u.status === "failed" || u.sessionUpdate === "tool_call")
          s.toolCalls.push({ title: u.title, kind: u.kind, status: u.status, ...(u.rawOutput ? { rawOutput: JSON.stringify(u.rawOutput).slice(0, 400) } : {}) });
      } else if (u.sessionUpdate === "usage_update") {
        s.usageUpdates.push(u);
      } else {
        s.otherUpdates[u.sessionUpdate] = (s.otherUpdates[u.sessionUpdate] ?? 0) + 1;
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") s.agentText = (s.agentText ?? "") + u.content.text;
      }
    })
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      const d = decide(ctx.params);
      decisions.push(d);
      return toResponse(ctx.params, d);
    })
    .connect(
      ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      ),
    );
  const agent = connection.agent;

  const started = Date.now();
  const report: any = { agent: AGENT, mode: REAL ? "real" : "stub", sessionsRequested: SESSIONS, startedAt: new Date().toISOString() };
  const watchdog = setTimeout(() => {
    report.timedOut = true;
    finish(1);
  }, TIMEOUT_MS);

  let finished = false;
  async function finish(code: number) {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    report.totalMs = Date.now() - started;
    report.sessions = [...sessions.values()];
    report.permissionDecisions = decisions;
    report.mcpCalls = mcpCalls;
    report.stubRequests = stubLog;
    report.agentStderrTail = stderr.split("\n").slice(-15).join("\n");
    const out = path.resolve(here, "..", "results", `${AGENT}-${REAL ? "real" : "stub"}.json`);
    try {
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(report, null, 2));
      printSummary(report, out);
    } catch (e) {
      console.error(`could not write report: ${e}`);
      code = 1;
    } finally {
      connection.close();
      child.kill("SIGTERM");
      setTimeout(() => process.exit(code), 500).unref();
      await Promise.allSettled([mcp.close(), stub?.close()]);
      process.exit(code);
    }
  }

  try {
    const init = await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    report.initialize = {
      protocolVersion: init.protocolVersion,
      agentInfo: init.agentInfo,
      authMethods: (init.authMethods ?? []).map((m: any) => ({ id: m.id, name: m.name, type: m.type })),
      mcpCapabilities: init.agentCapabilities?.mcpCapabilities,
      sessionCapabilities: Object.keys((init.agentCapabilities as any)?.sessionCapabilities ?? {}),
    };

    // Codex asks the client to pick an auth method; the key itself comes from env (the secrets store).
    const methodsOffered = (init.authMethods ?? []).map((m: any) => m.id);
    if (methodsOffered.includes("api-key") && (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || !REAL)) {
      await agent.request(methods.agent.authenticate, { methodId: "api-key" } as any);
      report.authenticatedWith = "api-key";
    }

    // Open N sessions, each with its own workspace and its own MCP token.
    for (let i = 0; i < SESSIONS; i++) {
      const cwd = path.join(root, `ws-${i}`);
      mkdirSync(cwd, { recursive: true });
      const token = newSessionToken();
      const s: SessionReport = { index: i, token, cwd, configOptions: [], toolCalls: [], usageUpdates: [], otherUpdates: {}, markerFile: false };
      const res = await agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [{ type: "http", name: "bossman", url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }],
      });
      s.sessionId = res.sessionId;
      s.configOptions = (res.configOptions ?? []).map((o) => ({
        id: o.id, name: o.name, category: (o as any).category, values: flattenOptions(o), current: (o as any).currentValue,
      }));
      sessions.set(res.sessionId, s);
    }

    if (PIN_MODEL && AGENT === "claude") {
      // With the alias pinned, selecting "opus" should route to the pinned model.
      for (const s of sessions.values())
        await agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId!, configId: "model", value: "opus" } as any);
    }
    report.pinModel = PIN_MODEL || undefined;

    // R8: can a model the agent did not list be selected (the free-text override)?
    const first = [...sessions.values()][0];
    const modelOpt = first?.configOptions.find((o) => o.category === "model" || o.id === "model");
    if (first?.sessionId && modelOpt) {
      const tried = AGENT === "claude" ? "claude-future-model-x" : "gpt-future-model-x";
      try {
        await agent.request(methods.agent.session.setConfigOption, { sessionId: first.sessionId, configId: modelOpt.id, value: tried } as any);
        first.freeTextModel = { tried, ok: true };
      } catch (e: any) {
        first.freeTextModel = { tried, ok: false, error: String(e?.message ?? e) };
      }
    }

    // Prompt every session at once: the concurrency test.
    await Promise.all(
      [...sessions.values()].map(async (s) => {
        const t0 = Date.now();
        try {
          const r = await agent.request(methods.agent.session.prompt, {
            sessionId: s.sessionId!,
            prompt: [{ type: "text", text: REAL ? REAL_PROMPT : STUB_PROMPT }],
          });
          s.stopReason = r.stopReason;
        } catch (e: any) {
          s.error = String(e?.message ?? e);
        }
        s.ms = Date.now() - t0;
        s.markerFile = existsSync(path.join(s.cwd, "spike.txt"));
      }),
    );
    await finish(0);
  } catch (e: any) {
    report.fatal = String(e?.stack ?? e);
    await finish(1);
  }
}

function printSummary(r: any, out: string) {
  const lines: string[] = [];
  lines.push(`\n== Spike S2: ${r.agent} (${r.mode}) — ${r.totalMs} ms${r.timedOut ? " — TIMED OUT" : ""}`);
  if (r.fatal) lines.push(`FATAL: ${r.fatal.split("\n")[0]}`);
  if (r.initialize) lines.push(`agent: ${r.initialize.agentInfo?.name} ${r.initialize.agentInfo?.version}; protocol v${r.initialize.protocolVersion}; auth methods: ${r.initialize.authMethods.map((m: any) => m.id).join(", ") || "none"}`);
  for (const s of r.sessions ?? []) {
    const models = s.configOptions.find((o: any) => o.category === "model" || o.id === "model");
    lines.push(
      `session ${s.index}: stop=${s.stopReason ?? s.error ?? "?"} ms=${s.ms} marker=${s.markerFile} tools=${s.toolCalls.length} models=${models ? models.values.length : 0}` +
        (s.freeTextModel ? ` freeText(${s.freeTextModel.tried})=${s.freeTextModel.ok ? "accepted" : "rejected"}` : ""),
    );
  }
  const byToken = new Map<string, number>();
  for (const c of r.mcpCalls) byToken.set(c.token ?? "none", (byToken.get(c.token ?? "none") ?? 0) + 1);
  lines.push(`mcp calls: ${r.mcpCalls.length} across ${byToken.size} distinct session tokens`);
  lines.push(`permission decisions: ${r.permissionDecisions.map((d: any) => `${d.verdict}(${d.rule})`).join(", ") || "none"}`);
  lines.push(`report: ${out}`);
  console.log(lines.join("\n"));
}

void main();
