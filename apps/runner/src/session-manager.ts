// Runs agents over ACP for one company (Phase 2b). One adapter process per run, so a
// crash or hang in one run can't take another down. Lessons from spike S2 are built in:
// models are pinned at launch, Codex starts in workspace-write so approvals reach Boss Man,
// and cost is reported as deltas (R34).
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION as ACP_PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { parseAcpUsageCost, type RunnerCommand, type RunnerEvent } from "@boss-man/shared";
import { gitAuthEnv, type Workspaces } from "./workspace.js";

type StartCommand = Extract<RunnerCommand, { type: "run.start" }>;

export type SessionManagerOptions = {
  emit: (event: RunnerEvent) => void;
  /** The company's granted secrets for this run, fetched from the server (which logs the access). */
  resolveEnv: (runId: string) => Promise<Record<string, string>>;
  /** Boss Man's MCP endpoint as agents reach it. */
  mcpUrl: string;
  /** Environment every agent inherits (PATH, HOME, proxy settings); secrets are added per run. */
  baseEnv?: NodeJS.ProcessEnv;
  /** How long a permission request waits for a verdict before it is refused. */
  permissionTimeoutMs?: number;
  /** Override adapter executables, e.g. in tests. */
  adapterBins?: Partial<Record<string, string>>;
  /** Where active runs are recorded, so a restart can report them as interrupted (R42). */
  stateFile?: string;
  /** Git worktrees per ticket (R38). Without it, runs use the cwd they're given. */
  workspaces?: Workspaces;
  log?: (msg: string) => void;
};

const CLAUDE_ALIASES = new Set(["default", "opus", "sonnet", "haiku", "fable"]);
const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_EXECUTABLE", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];

const require = createRequire(import.meta.url);
function defaultBin(agentKind: string): string {
  const pkg = agentKind === "claude" ? "@agentclientprotocol/claude-agent-acp" : agentKind === "codex" ? "@agentclientprotocol/codex-acp" : null;
  if (!pkg) throw new Error(`No ACP adapter is registered for agent kind "${agentKind}".`);
  const manifest = require(`${pkg}/package.json`) as { bin: Record<string, string> | string };
  const rel = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin)[0]!;
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), rel);
}

type RunState = {
  child: ChildProcess;
  sessionId: string | null;
  cancel: () => void;
  pendingPermissions: Map<string, (verdict: "allow" | "deny") => void>;
  /** Owner or CEO messages waiting to be sent as the next prompt (R37). */
  queued: string[];
};

/** Stops an adapter and everything it started; escalates to SIGKILL if the group lingers. */
function killGroup(child: ChildProcess, graceMs = 5000) {
  const pid = child.pid;
  if (!pid) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false; // the group is already gone
    }
  };
  if (signal("SIGTERM")) setTimeout(() => signal("SIGKILL"), graceMs).unref();
}

export class SessionManager {
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly opts: SessionManagerOptions) {}

  /**
   * After a restart: every run the last process left unfinished is reported as interrupted,
   * so the server can start a recovery run (R42). Call once, before handling commands.
   */
  recoverInterrupted() {
    const file = this.opts.stateFile;
    if (!file || !existsSync(file)) return [];
    let leftover: string[] = [];
    try {
      leftover = (JSON.parse(readFileSync(file, "utf8")) as { runs?: string[] }).runs ?? [];
    } catch {
      this.opts.log?.("couldn't read the active-runs file; starting clean");
    }
    for (const runId of leftover) {
      this.opts.emit({ type: "run.ended", runId, stopReason: null, error: "The runner restarted while this run was going.", interrupted: true });
    }
    this.saveState();
    return leftover;
  }

  private saveState() {
    const file = this.opts.stateFile;
    if (!file) return;
    // Write-then-rename so a crash mid-write can't leave a torn file.
    writeFileSync(`${file}.tmp`, JSON.stringify({ runs: [...this.runs.keys()] }));
    renameSync(`${file}.tmp`, file);
  }

  get activeRuns() {
    return this.runs.size;
  }

  /** Process group ids of active runs, one per adapter. */
  processGroups(): number[] {
    return [...this.runs.values()].flatMap((r) => (r.child.pid ? [r.child.pid] : []));
  }

  /** Ends every run's process group, e.g. when the runner shuts down. */
  shutdown() {
    for (const run of this.runs.values()) killGroup(run.child, 2000);
  }

  handle(command: RunnerCommand) {
    switch (command.type) {
      case "run.start":
        void this.start(command);
        return;
      case "run.cancel": {
        const run = this.runs.get(command.runId);
        if (!run) return;
        // A stop means stop: queued messages don't start another turn.
        run.queued.length = 0;
        run.cancel();
        return;
      }
      case "permission.decide":
        this.runs.get(command.runId)?.pendingPermissions.get(command.requestId)?.(command.verdict);
        return;
      case "workspace.release":
        void this.opts.workspaces
          ?.release({ projectId: command.projectId, ticketId: command.ticketId })
          .catch((err) => this.opts.emit({ type: "runner.log", level: "warn", message: `Couldn't release the workspace for ticket ${command.ticketId}: ${String((err as Error)?.message ?? err)}` }));
        return;
      case "run.message": {
        const run = this.runs.get(command.runId);
        if (!run) {
          this.opts.emit({ type: "runner.log", level: "warn", message: `A message for run ${command.runId} arrived after it ended.` });
          return;
        }
        run.queued.push(command.text);
        if (command.interrupt) run.cancel();
        return;
      }
    }
  }

  private launchEnv(cmd: StartCommand, secrets: Record<string, string>): NodeJS.ProcessEnv {
    const base = this.opts.baseEnv ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    for (const k of BASE_ENV_KEYS) if (base[k] !== undefined) env[k] = base[k];
    // A granted GIT_TOKEN reaches git through the environment only, for the agent's pushes too (R38).
    Object.assign(env, secrets, gitAuthEnv(secrets), { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    if (cmd.agentKind === "claude" && cmd.model && !CLAUDE_ALIASES.has(cmd.model)) {
      // ACP refuses unlisted models; pinning the alias at launch works (spike S2).
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = cmd.model;
    }
    if (cmd.agentKind === "codex") {
      // Codex's default mode sends approvals to its own reviewer instead of Boss Man (spike S2).
      env.INITIAL_AGENT_MODE = "workspace-write";
      const existing = base.CODEX_CONFIG ? (JSON.parse(base.CODEX_CONFIG) as Record<string, unknown>) : {};
      env.CODEX_CONFIG = JSON.stringify({ ...existing, ...(cmd.model ? { model: cmd.model } : {}) });
    }
    return env;
  }

  private async start(cmd: StartCommand) {
    const { emit } = this.opts;
    let lastCostMicros = 0;
    let lastQuota = "";
    let messageText = "";

    let env: NodeJS.ProcessEnv;
    let secrets: Record<string, string>;
    try {
      secrets = await this.opts.resolveEnv(cmd.runId);
      env = this.launchEnv(cmd, secrets);
    } catch (err) {
      emit({ type: "run.ended", runId: cmd.runId, stopReason: null, error: `Couldn't load the company's secrets: ${String(err)}` });
      return;
    }

    if (cmd.workspace) {
      if (!this.opts.workspaces) {
        emit({ type: "run.ended", runId: cmd.runId, stopReason: null, error: "This runner has no workspace directory configured." });
        return;
      }
      try {
        const spec = cmd.workspace;
        const ws = await this.opts.workspaces.ensure(spec, secrets);
        cmd = { ...cmd, cwd: ws.path };
        emit({ type: "run.workspace", runId: cmd.runId, ticketId: spec.ticketId, branch: ws.branch, baseCommit: ws.baseCommit, created: ws.created, restoredPatch: ws.restoredPatch });
      } catch (err) {
        emit({ type: "run.ended", runId: cmd.runId, stopReason: null, error: `Couldn't prepare the git workspace: ${String((err as Error)?.message ?? err).slice(0, 500)}` });
        return;
      }
    }

    let bin: string;
    try {
      mkdirSync(cmd.cwd, { recursive: true });
      bin = this.opts.adapterBins?.[cmd.agentKind] ?? defaultBin(cmd.agentKind);
    } catch (err) {
      emit({ type: "run.ended", runId: cmd.runId, stopReason: null, error: String((err as Error)?.message ?? err) });
      return;
    }
    // Its own process group: the adapter runs Claude Code as a child, and if the adapter dies
    // Claude Code carries on headless with every permission denied (spike S4). Ending the run
    // kills the whole group.
    const child = spawn(bin, [], { env, cwd: cmd.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr = (stderr + String(d)).slice(-4000);
    });

    const state: RunState = { child, sessionId: null, cancel: () => {}, pendingPermissions: new Map(), queued: [] };
    this.runs.set(cmd.runId, state);
    this.saveState();

    const onPermission = (req: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      const requestId = randomUUID();
      const pick = (kind: string) => req.options.find((o) => o.kind === kind);
      // Register for the verdict before announcing the request, so a fast verdict can't be lost.
      const verdict = new Promise<RequestPermissionResponse>((resolve) => {
        const settle = (v: "allow" | "deny") => {
          clearTimeout(timer);
          state.pendingPermissions.delete(requestId);
          const option = v === "allow" ? pick("allow_once") ?? pick("allow_always") : pick("reject_once") ?? pick("reject_always");
          resolve(option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
        };
        const timer = setTimeout(() => settle("deny"), this.opts.permissionTimeoutMs ?? 10 * 60_000);
        state.pendingPermissions.set(requestId, settle);
      });
      emit({
        type: "run.permission_request",
        runId: cmd.runId,
        requestId,
        title: req.toolCall.title ?? null,
        kind: req.toolCall.kind ?? null,
        rawInput: req.toolCall.rawInput ?? null,
        optionKinds: req.options.map((o) => o.kind),
      });
      return verdict;
    };

    const onUpdate = (n: SessionNotification) => {
      const u = n.update as Record<string, unknown> & { sessionUpdate: string };
      switch (u.sessionUpdate) {
        case "tool_call":
        case "tool_call_update":
          emit({ type: "run.update", runId: cmd.runId, update: { kind: u.sessionUpdate, title: u.title ?? null, toolKind: u.kind ?? null, status: u.status ?? null } });
          return;
        case "agent_message_chunk": {
          const content = u.content as { type?: string; text?: string } | undefined;
          if (content?.type === "text" && content.text) messageText += content.text;
          return;
        }
        case "usage_update": {
          if (!cmd.fundingSourceId) return;
          const cost = parseAcpUsageCost(u);
          if (cost) {
            // Treated as cumulative per session; a drop means the counter reset (R34).
            const delta = cost.costMicros >= lastCostMicros ? cost.costMicros - lastCostMicros : cost.costMicros;
            lastCostMicros = cost.costMicros;
            if (delta > 0) emit({ type: "run.cost", runId: cmd.runId, fundingSourceId: cmd.fundingSourceId, costMicrosDelta: delta, model: cost.model });
          }
          const meta = u._meta as Record<string, unknown> | undefined;
          const rl = meta?.["_claude/rateLimit"];
          if (rl) {
            const key = JSON.stringify(rl);
            if (key !== lastQuota) {
              lastQuota = key;
              emit({ type: "run.quota", fundingSourceId: cmd.fundingSourceId, claudeMeta: { "_claude/rateLimit": rl } });
            }
          }
          return;
        }
        default:
          return;
      }
    };

    const connection = acpClient({ name: "boss-man-runner" })
      .onNotification(methods.client.session.update, (ctx) => onUpdate(ctx.params as SessionNotification))
      .onRequest(methods.client.session.requestPermission, (ctx) => onPermission(ctx.params))
      .connect(
        ndJsonStream(
          Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
        ),
      );
    const agent = connection.agent;

    const finish = (stopReason: string | null, error: string | null) => {
      if (!this.runs.has(cmd.runId)) return;
      this.runs.delete(cmd.runId);
      this.saveState();
      for (const settle of state.pendingPermissions.values()) settle("deny");
      if (messageText) emit({ type: "run.update", runId: cmd.runId, update: { kind: "agent_message", text: messageText.slice(0, 20_000) } });
      emit({ type: "run.ended", runId: cmd.runId, stopReason, error });
      connection.close();
      killGroup(child);
    };
    child.on("exit", (code) => {
      if (this.runs.has(cmd.runId)) finish(null, `The agent process exited (code ${code}). ${stderr.split("\n").slice(-3).join(" ")}`.trim());
    });

    try {
      const init = await agent.request(methods.agent.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const authIds = (init.authMethods ?? []).map((m) => m.id);
      if (authIds.includes("api-key") && (env.CODEX_API_KEY || env.OPENAI_API_KEY)) {
        await agent.request(methods.agent.authenticate, { methodId: "api-key" } as never);
      }

      const mcpServers = [{ type: "http" as const, name: "bossman", url: this.opts.mcpUrl, headers: [{ name: "Authorization", value: `Bearer ${cmd.mcpToken}` }] }];
      // Recovery (R42): reopen the interrupted session if the agent can, else start fresh.
      // A crash before Claude Code flushes its transcript leaves nothing to load (spike S4).
      const openSession = async (): Promise<{ sessionId: string; configOptions?: unknown[] | null }> => {
        if (cmd.resumeSessionId && (init.agentCapabilities as { loadSession?: boolean } | undefined)?.loadSession) {
          try {
            const loaded = await agent.request(methods.agent.session.load, { sessionId: cmd.resumeSessionId, cwd: cmd.cwd, mcpServers });
            emit({ type: "run.update", runId: cmd.runId, update: { kind: "resumed", mode: "load" } });
            return { sessionId: cmd.resumeSessionId, configOptions: (loaded as { configOptions?: unknown[] | null } | null)?.configOptions ?? null };
          } catch (err) {
            this.opts.log?.(`couldn't reopen session ${cmd.resumeSessionId}: ${String((err as Error)?.message ?? err)}; starting fresh`);
          }
        }
        const fresh = await agent.request(methods.agent.session.new, { cwd: cmd.cwd, mcpServers });
        if (cmd.resumeSessionId) emit({ type: "run.update", runId: cmd.runId, update: { kind: "resumed", mode: "fresh" } });
        return fresh as { sessionId: string; configOptions?: unknown[] | null };
      };
      const session = await openSession();
      state.sessionId = session.sessionId;
      state.cancel = () => void agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });

      let model = cmd.model;
      if (cmd.agentKind === "claude" && cmd.model) {
        // Listed aliases are selected directly; anything else was pinned to "opus" at launch.
        const value = CLAUDE_ALIASES.has(cmd.model) ? cmd.model : "opus";
        await agent.request(methods.agent.session.setConfigOption, { sessionId: session.sessionId, configId: "model", value } as never);
      }
      if (!model) {
        const opt = (session.configOptions ?? []).find((o) => (o as { category?: string }).category === "model") as { currentValue?: string } | undefined;
        model = opt?.currentValue ?? null;
      }
      emit({ type: "run.started", runId: cmd.runId, agentId: cmd.agentId, acpSessionId: session.sessionId, model });

      let result = await agent.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: cmd.prompt }] });
      // Messages that arrived during the turn continue the same session (R37).
      while (state.queued.length && this.runs.has(cmd.runId)) {
        const text = state.queued.splice(0).join("\n\n");
        emit({ type: "run.update", runId: cmd.runId, update: { kind: "message_delivered", text: text.slice(0, 2000) } });
        result = await agent.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text }] });
      }
      finish(result.stopReason, null);
    } catch (err) {
      finish(null, String((err as Error)?.message ?? err));
    }
  }
}
