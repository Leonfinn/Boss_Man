// Runs agents over ACP for one company (Phase 2b). One adapter process per run, so a
// crash or hang in one run can't take another down. Lessons from spike S2 are built in:
// models are pinned at launch, Codex starts in workspace-write so approvals reach Boss Man,
// and cost is reported as deltas (R34).
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION as ACP_PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import type { McpServer, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { parseAcpUsageCost, type RunnerCommand, type RunnerEvent } from "@boss-man/shared";
import { probeModels } from "./models-probe.js";
import { checkAddons } from "./addons.js";
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
  /** The company's granted secrets outside a run, e.g. a GIT_TOKEN for pushing a merge. */
  resolveCompanyEnv?: (purpose: "merge" | "check") => Promise<Record<string, string>>;
  /** Where each run's skills are written for the agent to load (R71). */
  skillsRoot?: string;
  /** Answers request commands such as workspace.diff. */
  reply?: (requestId: string, result: { ok: true; data: unknown } | { ok: false; error: string }) => void;
  /** Runs the setup-token check (R58), given only the token. */
  checkClaude?: (credentials: Record<string, string>) => Promise<{ ok: boolean; message: string }>;
  log?: (msg: string) => void;
};

type ToolCallContent = { type: string; content?: { type: string; text?: string } };
const isEmpty = (v: unknown) => v == null || (typeof v === "object" && Object.keys(v as object).length === 0);
/** The text parts of a tool call's content. */
/** ExitPlanMode's input carries the plan as `plan` once the CLI has filled it in. */
function planOf(rawInput: unknown): string {
  const plan = rawInput && typeof rawInput === "object" ? (rawInput as { plan?: unknown }).plan : undefined;
  return typeof plan === "string" ? plan : "";
}

const textOf = (content: ToolCallContent[] | null | undefined) =>
  (content ?? [])
    .flatMap((c) => (c.type === "content" && c.content?.type === "text" && c.content.text ? [c.content.text] : []))
    .join("\n\n");

/**
 * Writes skills as <dir>/.claude/skills/<name>/<files> and returns dir. Paths are checked
 * to stay inside each skill's folder.
 */
export function writeSkills(dir: string, list: NonNullable<StartCommand["skills"]>) {
  rmSync(dir, { recursive: true, force: true });
  const root = path.join(dir, ".claude", "skills");
  for (const skill of list) {
    const base = path.join(root, skill.name);
    for (const f of skill.files) {
      const target = path.resolve(base, f.path);
      if (!target.startsWith(base + path.sep)) throw new Error(`skill ${skill.name} has a file outside its folder: ${f.path}`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(f.content, "base64"));
    }
  }
  return dir;
}

const CLAUDE_ALIASES = new Set(["default", "opus", "sonnet", "haiku", "fable"]);

/** The choices in an ACP session's model option, groups flattened (R60). */
export function modelChoices(configOptions: unknown[] | null | undefined) {
  const opt = (configOptions ?? []).find((o) => (o as { category?: string }).category === "model") as { options?: unknown[] } | undefined;
  const out: Array<{ value: string; name: string; description: string | null }> = [];
  for (const o of opt?.options ?? []) {
    const group = o as { options?: unknown[] };
    for (const c of Array.isArray(group.options) ? group.options : [o]) {
      const { value, name, description } = c as { value?: unknown; name?: unknown; description?: unknown };
      if (typeof value === "string" && value) out.push({ value, name: typeof name === "string" ? name : value, description: typeof description === "string" ? description : null });
    }
  }
  return out.slice(0, 200);
}
const currentModel = (configOptions: unknown[] | null | undefined) =>
  ((configOptions ?? []).find((o) => (o as { category?: string }).category === "model") as { currentValue?: string } | undefined)?.currentValue;
/**
 * OpenCode's settings for a run or a model probe. OpenCode allows edits and shell commands unless
 * told to ask (spike); "ask" sends them to Boss Man. The inline config wins over a repo's opencode.json.
 * Provider settings (e.g. a local Ollama endpoint) arrive as a granted OPENCODE_CONFIG_CONTENT and are kept.
 */
export function opencodeEnv(granted: string | undefined, verdict: "ask" | "deny"): NodeJS.ProcessEnv {
  let existing: Record<string, unknown> = {};
  try {
    existing = granted ? (JSON.parse(granted) as Record<string, unknown>) : {};
  } catch {
    // JSON.parse quotes the input in its message; this is a secret, so say only which one.
    throw new Error("OPENCODE_CONFIG_CONTENT isn't valid JSON.");
  }
  const permission = { ...(existing.permission as object | undefined), edit: verdict, bash: verdict, webfetch: verdict, external_directory: verdict };
  // OpenCode's own hosted "opencode" provider needs no key and would send work to opencode.ai, so it's off.
  const disabled = [...new Set([...((existing.disabled_providers as string[] | undefined) ?? []), "opencode"])];
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...existing, autoupdate: false, share: "disabled", permission, disabled_providers: disabled }),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", // don't read ~/.claude as OpenCode config
  };
}

/** The end of an agent's stderr, for an exit message: blank lines and Bun's version banner dropped, so the error itself (e.g. EACCES) shows. */
export const stderrTail = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Bun v\d/.test(l))
    .join(" ")
    .slice(-600);

export const BASE_ENV_KEYS = ["PATH", "HOME", "LANG", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_EXECUTABLE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"];

const require = createRequire(import.meta.url);
/** OpenCode is its own ACP agent: `opencode acp`, from the opencode-ai npm package (the Dockerfile puts it on PATH). */
export const adapterArgs = (agentKind: string): string[] => (agentKind === "opencode" ? ["acp"] : []);
export function defaultBin(agentKind: string): string {
  if (agentKind === "opencode") return "opencode";
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
export function killGroup(child: ChildProcess, graceMs = 5000) {
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
  /** The model list last reported per agent kind, so it's sent only when it changes. */
  private readonly reportedModels = new Map<string, string>();

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

  /** Permission requests still waiting for a verdict, for the server to answer again after a reconnect. */
  pendingPermissions(): Array<{ runId: string; requestId: string }> {
    return [...this.runs.entries()].flatMap(([runId, state]) => [...state.pendingPermissions.keys()].map((requestId) => ({ runId, requestId })));
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

  private starting = new Set<string>();
  private cancelledEarly = new Set<string>();

  handle(command: RunnerCommand) {
    switch (command.type) {
      case "run.start":
        this.starting.add(command.runId);
        void this.start(command).finally(() => this.starting.delete(command.runId));
        return;
      case "run.cancel": {
        const run = this.runs.get(command.runId);
        if (!run) {
          // Still being set up: stopped before its agent starts. Unknown (lost in a restart, say):
          // say it ended, or the server waits on it forever.
          if (this.starting.has(command.runId)) this.cancelledEarly.add(command.runId);
          else this.opts.emit({ type: "run.ended", runId: command.runId, stopReason: "cancelled", error: null });
          return;
        }
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
      case "workspace.file": {
        const reply = this.opts.reply ?? (() => {});
        if (!this.opts.workspaces) {
          reply(command.requestId, { ok: false, error: "This runner has no workspace directory configured." });
          return;
        }
        this.opts.workspaces.readFile({ projectId: command.projectId, ticketId: command.ticketId }, command.path).then(
          (data) => reply(command.requestId, { ok: true, data }),
          (err) => reply(command.requestId, { ok: false, error: String((err as Error)?.message ?? err) }),
        );
        return;
      }
      case "workspace.diff": {
        const reply = this.opts.reply ?? (() => {});
        if (!this.opts.workspaces) {
          reply(command.requestId, { ok: false, error: "This runner has no workspace directory configured." });
          return;
        }
        const spec = { projectId: command.projectId, ticketId: command.ticketId };
        (command.range === "last_turn" ? this.opts.workspaces.lastTurnDiff(spec) : this.opts.workspaces.diff(spec)).then(
          (data) => reply(command.requestId, { ok: true, data }),
          (err) => reply(command.requestId, { ok: false, error: String((err as Error)?.message ?? err) }),
        );
        return;
      }
      case "workspace.verify":
      case "workspace.merge":
      case "workspace.push":
      case "workspace.detect": {
        const reply = this.opts.reply ?? (() => {});
        const ws = this.opts.workspaces;
        if (!ws) {
          reply(command.requestId, { ok: false, error: "This runner has no workspace directory configured." });
          return;
        }
        const work =
          command.type === "workspace.verify"
            ? ws.verify({ projectId: command.projectId, ticketId: command.ticketId }, command.command)
            : (this.opts.resolveCompanyEnv?.("merge") ?? Promise.resolve({})).then((secrets): Promise<unknown> =>
                command.type === "workspace.detect"
                  ? ws.detect({ projectId: command.projectId, repoUrl: command.repoUrl, baseRef: command.baseRef }, secrets)
                  : command.type === "workspace.push"
                    ? ws.pushForReview({ projectId: command.projectId, ticketId: command.ticketId }, command.target, secrets)
                    : ws.merge({ projectId: command.projectId, ticketId: command.ticketId }, command.target, command.message, secrets),
              );
        work.then(
          (data) => reply(command.requestId, { ok: true, data }),
          (err) => reply(command.requestId, { ok: false, error: String((err as Error)?.message ?? err).slice(0, 1000) }),
        );
        return;
      }
      case "credential.check": {
        // Only the setup-token goes to the check, so an API key granted alongside it can't stand in for it (R58).
        const reply = this.opts.reply ?? (() => {});
        const check = this.opts.checkClaude;
        if (!check) {
          reply(command.requestId, { ok: false, error: "This runner can't run credential checks." });
          return;
        }
        (this.opts.resolveCompanyEnv?.("check") ?? Promise.resolve({} as Record<string, string>))
          .then((env) => check(env.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN } : {}))
          .then(
            (data) => reply(command.requestId, { ok: true, data }),
            (err) => reply(command.requestId, { ok: false, error: String((err as Error)?.message ?? err).slice(0, 1000) }),
          );
        return;
      }
      case "addons.check": {
        const reply = this.opts.reply ?? (() => {});
        checkAddons(this.opts.baseEnv?.BOSSMAN_ADDONS ?? process.env.BOSSMAN_ADDONS).then((data) => reply(command.requestId, { ok: true, data }));
        return;
      }
      case "models.probe": {
        const reply = this.opts.reply ?? (() => {});
        (this.opts.resolveCompanyEnv?.("check") ?? Promise.resolve({} as Record<string, string>))
          .then((env) => probeModels(command.agentKind, env, { baseEnv: this.opts.baseEnv, adapterBin: this.opts.adapterBins?.[command.agentKind] }))
          .then(
            (models) => {
              if (models.length) {
                this.reportedModels.set(command.agentKind, JSON.stringify(models));
                this.opts.emit({ type: "runner.models", agentKind: command.agentKind, models });
              }
              reply(command.requestId, { ok: true, data: { models } });
            },
            (err) => reply(command.requestId, { ok: false, error: String((err as Error)?.message ?? err).slice(0, 1000) }),
          );
        return;
      }
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
    // shortcut: owner chat (boardToolsOnly) denies edit/bash/web but leaves OpenCode's read-only tools on, upgrade if they must go too.
    if (cmd.agentKind === "opencode") Object.assign(env, opencodeEnv(secrets.OPENCODE_CONFIG_CONTENT ?? base.OPENCODE_CONFIG_CONTENT, cmd.boardToolsOnly ? "deny" : "ask"));
    return env;
  }

  private async start(cmd: StartCommand) {
    const { emit } = this.opts;
    let lastCostMicros = 0;
    let lastContextUsed = -Infinity;
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
        if (spec.review) cmd = { ...cmd, cwd: (await this.opts.workspaces.ensureReview(spec, secrets)).path };
        else {
          const ws = await this.opts.workspaces.ensure(spec, secrets);
          cmd = { ...cmd, cwd: ws.path };
          emit({ type: "run.workspace", runId: cmd.runId, ticketId: spec.ticketId, branch: ws.branch, baseCommit: ws.baseCommit, created: ws.created, restoredPatch: ws.restoredPatch });
        }
      } catch (err) {
        emit({ type: "run.ended", runId: cmd.runId, stopReason: null, error: `Couldn't prepare the git workspace: ${String((err as Error)?.message ?? err).slice(0, 500)}` });
        return;
      }
    }

    // Skills (R71) go in a folder of their own, passed to Claude as an extra directory, so its
    // .claude/skills are loaded without touching the repo's worktree or the shared home.
    let skillsDir: string | null = null;
    if (cmd.skills?.length && cmd.agentKind === "claude") {
      try {
        skillsDir = writeSkills(path.join(this.opts.skillsRoot ?? path.join(tmpdir(), "bossman-skills"), cmd.runId), cmd.skills);
      } catch (err) {
        emit({ type: "run.ended", runId: cmd.runId, stopReason: null, error: `Couldn't set up the agent's skills: ${String((err as Error)?.message ?? err)}` });
        return;
      }
    }
    const dropSkills = () => skillsDir && rmSync(skillsDir, { recursive: true, force: true });
    if (this.cancelledEarly.delete(cmd.runId)) {
      dropSkills();
      emit({ type: "run.ended", runId: cmd.runId, stopReason: "cancelled", error: null });
      return;
    }

    let bin: string;
    try {
      mkdirSync(cmd.cwd, { recursive: true });
      bin = this.opts.adapterBins?.[cmd.agentKind] ?? defaultBin(cmd.agentKind);
    } catch (err) {
      dropSkills();
      emit({ type: "run.ended", runId: cmd.runId, stopReason: null, error: String((err as Error)?.message ?? err) });
      return;
    }
    // Its own process group: the adapter runs Claude Code as a child, and if the adapter dies
    // Claude Code carries on headless with every permission denied (spike S4). Ending the run
    // kills the whole group.
    const child = spawn(bin, adapterArgs(cmd.agentKind), { env, cwd: cmd.cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr = (stderr + String(d)).slice(-4000);
    });

    const state: RunState = { child, sessionId: null, cancel: () => {}, pendingPermissions: new Map(), queued: [] };
    const toolCalls = new Map<string, { rawInput: unknown; text: string }>();
    this.runs.set(cmd.runId, state);
    this.saveState();

    const onPermission = async (req: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      const requestId = randomUUID();
      const pick = (kind: string) => req.options.find((o) => o.kind === kind);
      const id = req.toolCall.toolCallId;
      // A plan approval needs the plan. The adapter can send the request before the tool call
      // update that carries the plan text has been handled here, so wait briefly for it.
      if (req.toolCall.kind === "switch_mode" && !textOf(req.toolCall.content) && !planOf(req.toolCall.rawInput)) {
        for (let i = 0; i < 100 && !toolCalls.get(id)?.text && this.runs.has(cmd.runId); i++) await new Promise((r) => setTimeout(r, 20));
      }
      // The request only adds what's new since the tool call was announced, so fill in its input
      // and text (e.g. the plan when the agent asks to leave plan mode) from what was seen then.
      const seen = toolCalls.get(id);
      const rawInput = isEmpty(req.toolCall.rawInput) ? (seen?.rawInput ?? req.toolCall.rawInput ?? null) : req.toolCall.rawInput;
      const detail = (textOf(req.toolCall.content) || seen?.text || planOf(rawInput) || "").slice(0, 20_000);
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
        rawInput,
        optionKinds: req.options.map((o) => o.kind),
        ...(detail ? { detail } : {}),
      });
      return verdict;
    };

    // session/load replays the old conversation as updates; that history isn't this run's work.
    let replaying = false;
    const onUpdate = (n: SessionNotification) => {
      if (replaying) return;
      const u = n.update as Record<string, unknown> & { sessionUpdate: string };
      switch (u.sessionUpdate) {
        case "tool_call":
        case "tool_call_update": {
          // Remembered for a permission request about the same call; bounded per run.
          const id = u.toolCallId as string | undefined;
          if (id) {
            const prev = toolCalls.get(id) ?? { rawInput: null, text: "" };
            const text = textOf(u.content as ToolCallContent[] | undefined);
            toolCalls.set(id, { rawInput: isEmpty(u.rawInput) ? prev.rawInput : u.rawInput, text: text || prev.text });
            if (toolCalls.size > 200) toolCalls.delete(toolCalls.keys().next().value!);
          }
          emit({ type: "run.update", runId: cmd.runId, update: { kind: u.sessionUpdate, title: u.title ?? null, toolKind: u.kind ?? null, status: u.status ?? null } });
          return;
        }
        case "agent_message_chunk": {
          const content = u.content as { type?: string; text?: string } | undefined;
          if (content?.type === "text" && content.text) messageText += content.text;
          return;
        }
        case "usage_update": {
          // Context fill, for CEO chapters: reported when it moves by 1% of the window or more.
          if (typeof u.used === "number" && typeof u.size === "number" && u.size > 0 && Math.abs(u.used - lastContextUsed) >= u.size / 100) {
            lastContextUsed = u.used;
            emit({ type: "run.context", runId: cmd.runId, used: Math.round(u.used), size: Math.round(u.size) });
          }
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

    // Token use over the run's turns, from each PromptResponse.usage (ACP marks it unstable) (R67).
    let usage: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedWriteTokens: number } | undefined;
    const countTokens = (response: unknown) => {
      const u = (response as { usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number | null; cachedWriteTokens?: number | null } | null } | null)?.usage;
      if (!u || typeof u.inputTokens !== "number" || typeof u.outputTokens !== "number") return;
      const n = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? Math.round(v) : 0);
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + n(u.inputTokens),
        outputTokens: (usage?.outputTokens ?? 0) + n(u.outputTokens),
        cachedReadTokens: (usage?.cachedReadTokens ?? 0) + n(u.cachedReadTokens),
        cachedWriteTokens: (usage?.cachedWriteTokens ?? 0) + n(u.cachedWriteTokens),
      };
    };
    const finish = (stopReason: string | null, error: string | null) => {
      if (!this.runs.has(cmd.runId)) return;
      this.runs.delete(cmd.runId);
      this.saveState();
      for (const settle of state.pendingPermissions.values()) settle("deny");
      if (messageText) emit({ type: "run.update", runId: cmd.runId, update: { kind: "agent_message", text: messageText.slice(0, 20_000) } });
      emit({ type: "run.ended", runId: cmd.runId, stopReason, error, ...(usage ? { usage } : {}) });
      connection.close();
      killGroup(child);
      dropSkills();
    };
    // "close", not "exit": by then stderr is fully read, and it holds the reason the agent died.
    child.on("close", (code) => {
      if (this.runs.has(cmd.runId)) finish(null, `The agent process exited (code ${code}). ${stderrTail(stderr)}`.trim());
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

      const mcpServers: McpServer[] = [{ type: "http", name: "bossman", url: this.opts.mcpUrl, headers: [{ name: "Authorization", value: `Bearer ${cmd.mcpToken}` }] }];
      // The company's extra tool servers: the token comes from this run's granted secrets, so an agent without it never gets the server.
      const supported = (init.agentCapabilities as { mcpCapabilities?: Record<string, boolean | undefined> } | undefined)?.mcpCapabilities;
      for (const m of cmd.mcpServers ?? []) {
        const token = m.secretEnv ? secrets[m.secretEnv] : undefined;
        if (m.secretEnv && !token) continue;
        if (!supported?.[m.transport]) {
          emit({ type: "runner.log", level: "warn", message: `Tool server ${m.name} skipped: this agent doesn't support ${m.transport} MCP servers.` });
          continue;
        }
        const headers = token ? [{ name: m.headerName, value: m.headerValue.replaceAll("{secret}", () => token) }] : [];
        mcpServers.push({ type: m.transport, name: m.name, url: m.url, headers });
      }
      // Board tools only (owner chat): Claude's built-in tools are switched off through the
      // adapter's session options, so only the Boss Man MCP tools remain.
      const sessionMeta = cmd.boardToolsOnly && cmd.agentKind === "claude" ? { _meta: { claudeCode: { options: { tools: [] } } } } : {};
      const extraDirs = skillsDir ? { additionalDirectories: [skillsDir] } : {};
      // Recovery (R42): reopen the interrupted session if the agent can, else start fresh.
      // A crash before Claude Code flushes its transcript leaves nothing to load (spike S4).
      const openSession = async (): Promise<{ sessionId: string; configOptions?: unknown[] | null; resumed: boolean }> => {
        if (cmd.resumeSessionId && (init.agentCapabilities as { loadSession?: boolean } | undefined)?.loadSession) {
          try {
            replaying = true;
            const loaded = await agent.request(methods.agent.session.load, { sessionId: cmd.resumeSessionId, cwd: cmd.cwd, mcpServers, ...extraDirs, ...sessionMeta }).finally(() => (replaying = false));
            emit({ type: "run.update", runId: cmd.runId, update: { kind: "resumed", mode: "load" } });
            return { sessionId: cmd.resumeSessionId, configOptions: (loaded as { configOptions?: unknown[] | null } | null)?.configOptions ?? null, resumed: true };
          } catch (err) {
            this.opts.log?.(`couldn't reopen session ${cmd.resumeSessionId}: ${String((err as Error)?.message ?? err)}; starting fresh`);
          }
        }
        const fresh = await agent.request(methods.agent.session.new, { cwd: cmd.cwd, mcpServers, ...extraDirs, ...sessionMeta });
        if (cmd.resumeSessionId) emit({ type: "run.update", runId: cmd.runId, update: { kind: "resumed", mode: "fresh" } });
        return { ...(fresh as { sessionId: string; configOptions?: unknown[] | null }), resumed: false };
      };
      const session = await openSession();
      state.sessionId = session.sessionId;
      state.cancel = () => void agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });

      let model = cmd.model;
      if (cmd.agentKind === "opencode" && cmd.model && cmd.model !== currentModel(session.configOptions)) {
        // Model ids are provider/model, as the session lists them (spike).
        await agent.request(methods.agent.session.setConfigOption, { sessionId: session.sessionId, configId: "model", value: cmd.model } as never);
      }
      if (cmd.agentKind === "claude" && cmd.model) {
        // Listed aliases are selected directly; anything else was pinned to "opus" at launch.
        const value = CLAUDE_ALIASES.has(cmd.model) ? cmd.model : "opus";
        await agent.request(methods.agent.session.setConfigOption, { sessionId: session.sessionId, configId: "model", value } as never);
      }
      // Plan-first tickets (R40) start in plan mode; a reopened session keeps the mode it had.
      // shortcut: OpenCode's plan mode has no approval step Boss Man understands, so plan-first tickets run in build mode for it; add one if wanted.
      if (cmd.mode === "plan" && !session.resumed && cmd.agentKind === "claude") {
        await agent.request(methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "plan" });
      }
      if (!model) {
        const opt = (session.configOptions ?? []).find((o) => (o as { category?: string }).category === "model") as { currentValue?: string } | undefined;
        model = opt?.currentValue ?? null;
      }
      // Tell the server what this agent kind offers, when it's new or has changed (R60).
      const choices = modelChoices(session.configOptions);
      const seen = JSON.stringify(choices);
      if (choices.length && this.reportedModels.get(cmd.agentKind) !== seen) {
        this.reportedModels.set(cmd.agentKind, seen);
        emit({ type: "runner.models", agentKind: cmd.agentKind, models: choices });
      }
      emit({ type: "run.started", runId: cmd.runId, agentId: cmd.agentId, acpSessionId: session.sessionId, model, resumed: session.resumed });

      // A session that couldn't be reopened gets the full prompt, so it doesn't miss what the old one knew.
      const first = !session.resumed && cmd.resumeSessionId && cmd.freshPrompt ? cmd.freshPrompt : cmd.prompt;
      // Turn checkpoints (R39): the worktree before the run, then after each turn.
      const checkpoint = async (label: string) => {
        // A reviewer's run checkpoints nothing: its copy isn't the ticket's worktree.
        if (!cmd.workspace || cmd.workspace.review || !this.opts.workspaces) return;
        try {
          const c = await this.opts.workspaces.checkpoint(cmd.workspace, `${label} (run ${cmd.runId})`);
          if (c && label !== "before the run") emit({ type: "run.update", runId: cmd.runId, update: { kind: "checkpoint", turn: c.turn, files: c.files } });
        } catch (err) {
          emit({ type: "runner.log", level: "warn", message: `Couldn't record a checkpoint for ticket ${cmd.workspace.ticketId}: ${String((err as Error)?.message ?? err).slice(0, 300)}` });
        }
      };
      await checkpoint("before the run");
      let result = await agent.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text: first }] });
      countTokens(result);
      await checkpoint("after a turn");
      // Messages that arrived during the turn continue the same session (R37).
      while (state.queued.length && this.runs.has(cmd.runId)) {
        const text = state.queued.splice(0).join("\n\n");
        emit({ type: "run.update", runId: cmd.runId, update: { kind: "message_delivered", text: text.slice(0, 2000) } });
        result = await agent.request(methods.agent.session.prompt, { sessionId: session.sessionId, prompt: [{ type: "text", text }] });
        countTokens(result);
        await checkpoint("after a turn");
      }
      finish(result.stopReason, null);
    } catch (err) {
      // A dying agent shows first as "ACP connection closed"; wait briefly so its exit message (with stderr) is reported instead.
      if (child.exitCode === null && child.signalCode === null) await new Promise((r) => setTimeout(r, 2000));
      if (this.runs.has(cmd.runId)) finish(null, String((err as Error)?.message ?? err));
    }
  }
}
