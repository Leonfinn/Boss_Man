// Model list without a chat message: opens an ACP session with session/new and no prompt,
// reads the model option, and closes it. claude-agent-acp's session/new only starts Claude Code
// and asks it to initialize (a local control request); no model request is made until a prompt
// is sent. Like the setup-token check, it runs in a throwaway folder, with no Boss Man tools.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION as ACP_PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { BASE_ENV_KEYS, adapterArgs, defaultBin, killGroup, modelChoices, opencodeEnv, stderrTail, withoutGitCredentials } from "./session-manager.js";
import { INFINITE_MODEL_CHOICE, isInfiniteModel } from "@boss-man/shared";

export type ProbedModels = Array<{ value: string; name: string; description: string | null }>;

/**
 * Synthetic's Infinite mode (BOS-279) isn't in a stock OpenCode's model list, and this probe has no
 * Synthetic key to ask the provider, so it is offered for OpenCode under the name the server stores. A
 * run on it works because the runner adds the provider (session-manager.ts, opencodeEnv).
 */
const addInfiniteChoice = (agentKind: string, choices: ProbedModels): ProbedModels =>
  agentKind === "opencode" && !choices.some((c) => isInfiniteModel(c.value)) ? [...choices, { ...INFINITE_MODEL_CHOICE, description: INFINITE_MODEL_CHOICE.description }] : choices;

/** What a probe's Claude Code may see of the runner's environment: enough to start and get out through a proxy. */
const CLAUDE_PASSED_ON = ["PATH", "LANG", "TZ", "CLAUDE_CODE_EXECUTABLE", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

export async function probeModels(
  agentKind: string,
  credentials: Record<string, string>,
  opts: { baseEnv?: NodeJS.ProcessEnv; adapterBin?: string; timeoutMs?: number } = {},
): Promise<ProbedModels> {
  const base = opts.baseEnv ?? process.env;
  const home = mkdtempSync(path.join(tmpdir(), "bm-models-"));
  const cwd = path.join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  if (agentKind === "claude") {
    for (const k of CLAUDE_PASSED_ON) if (base[k] !== undefined) env[k] = base[k];
    env.HOME = home;
    env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
    // In a fenced check job /tmp is refused and Claude Code's own /tmp/claude-<uid> ends the probe with "Internal error" (BOS-1067).
    if (opts.baseEnv !== undefined) {
      const t = process.env.CLAUDE_CODE_TMPDIR ?? process.env.TMPDIR;
      if (t !== undefined) env.CLAUDE_CODE_TMPDIR = t;
    }
  } else {
    // Codex keeps its login in CODEX_HOME, so the runner's own settings are kept.
    for (const k of BASE_ENV_KEYS) if (base[k] !== undefined) env[k] = base[k];
  }
  // A probe is an unscoped client of the adapter, so it gets the same withheld git credential as a run (BOS-322).
  const rest = withoutGitCredentials(credentials);
  Object.assign(env, rest, { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
  // The same OpenCode settings as a run, so the list leaves out models a run can't use (its hosted provider).
  if (agentKind === "opencode") Object.assign(env, opencodeEnv(rest.OPENCODE_CONFIG_CONTENT ?? base.OPENCODE_CONFIG_CONTENT, "deny"));
  const child = spawn(opts.adapterBin ?? defaultBin(agentKind), adapterArgs(agentKind), { env, cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-2000)));
  const connection = acpClient({ name: "boss-man-runner" }).connect(
    ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>),
  );
  const agent = connection.agent;
  const exited = new Promise<never>((_, reject) => {
    child.on("error", (err) => reject(new Error(`Couldn't start the ${agentKind} adapter: ${err.message}`)));
    // "close", not "exit": by then stderr is fully read, and it holds the reason (e.g. opencode's EACCES).
    child.on("close", (code) => reject(new Error(`The agent process exited (code ${code}). ${stderrTail(stderr)}`.trim())));
  });
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${agentKind} didn't report its models within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)));
  const work = async () => {
    const init = await agent.request(methods.agent.initialize, { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if ((init.authMethods ?? []).some((m) => m.id === "api-key") && (env.CODEX_API_KEY || env.OPENAI_API_KEY)) await agent.request(methods.agent.authenticate, { methodId: "api-key" } as never);
    const meta = agentKind === "claude" ? { _meta: { claudeCode: { options: { tools: [] } } } } : {};
    const session = await agent.request(methods.agent.session.new, { cwd, mcpServers: [], ...meta });
    return modelChoices((session as { configOptions?: unknown[] | null }).configOptions);
  };
  try {
    // A dying agent shows first as "ACP connection closed"; give its exit message a moment to win.
    const reported = work().catch(async (err) => {
      await new Promise((r) => setTimeout(r, 2000));
      throw err;
    });
    const choices = await Promise.race([reported, exited, timeout]);
    return addInfiniteChoice(agentKind, choices);
  } finally {
    clearTimeout(timer);
    child.removeAllListeners("close");
    child.on("error", () => {});
    connection.close();
    killGroup(child);
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover temp folder doesn't change the result.
    }
  }
}
