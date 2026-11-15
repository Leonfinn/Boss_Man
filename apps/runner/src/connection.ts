// The runner's link to the Boss Man server (R31): dial out, say hello, replay what the
// server hasn't stored, then stream live. Reconnects with backoff; a connection that
// goes quiet for three heartbeats is dropped and redialled.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { HEARTBEAT_MS, PROTOCOL_VERSION, RUNNER_FEATURES, ServerMessage, type HarnessVersions, type Toolchain, type RunnerCommand, type RunnerEvent, type RunnerMessage, type WorkerMessage, type WorkerRepos } from "@boss-man/shared";
import type { Journal } from "./journal.js";

export type ConnectionOptions = {
  url: string;
  token: string;
  /** Required for a company runner; a check worker (checkWorker set) has none. */
  journal?: Journal;
  onCommand: (command: RunnerCommand) => void;
  runnerVersion: string;
  imageVersion?: string | null;
  /** The git commit the image was built from (BOS-764), told to the server in hello. */
  imageCommit?: string;
  /** The tools checks run with and their fingerprint (BOS-1570), told to the server in hello. */
  toolchain?: Toolchain;
  /** Versions of the harnesses in the image, told to the server in hello (BOS-305). */
  harnessVersions?: HarnessVersions;
  heartbeatMs?: number;
  log?: (msg: string) => void;
  /** Permission requests still waiting for a verdict, re-asked on every (re)connect. */
  pendingPermissions?: () => Array<{ runId: string; requestId: string }>;
  /** Why this process started, told to the server in every hello so it can record the restart's reason (BOS-594). */
  restart?: { previousExit?: "stopped" | "crashed" | null; hostBootAt?: string | null };
  /** Check jobs running now (BOS-316), listed in hello. */
  runningChecks?: () => string[];
  /** How many checks this runner runs at once (BOS-1471), listed in hello so the server never starts more here. */
  checkSlots?: number;
  /** Called after the server’s welcome: resend check results it may not have. */
  onWelcome?: () => void;
  /** Ids of the runs the runner has now; the server closes any other open run (BOS-583). */
  liveRuns?: () => string[];
  /**
   * BOS-1435: this process is a check worker (BOSSMAN_ROLE=check-worker). Its hello carries only what the worker socket
   * reads (check features, its slot count, running checks), and it keeps no journal: the worker socket takes no events.
   */
  checkWorker?: { slots: number; features: readonly string[]; /** BOS-1436: the commits it holds per project, for thin bundles. */ repos?: () => WorkerRepos };
};

export class RunnerConnection {
  private ws: WebSocket | null = null;
  private live = false;
  private stopped = false;
  private attempt = 0;
  private lastHeard = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;
  /** New for each process start; sent in every hello so the server can tell a restart from a reconnect (BOS-352). */
  private readonly bootId = randomUUID();

  constructor(private readonly opts: ConnectionOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  }

  get isLive() {
    return this.live;
  }

  start() {
    this.stopped = false;
    this.dial();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.teardown();
  }

  /** Journals the event, then sends it if connected; otherwise it goes out on the next replay. */
  emit(event: RunnerEvent) {
    // A check worker journals nothing: its socket refuses events (callers in worker mode don't emit; this is the backstop).
    if (this.opts.checkWorker || !this.opts.journal) return null;
    const entry = this.opts.journal.append(event);
    if (this.live) this.send({ type: "event", entry });
    return entry;
  }

  /** Answers a request command directly. Replies aren't journalled; the server asks again if one is lost. */
  reply(requestId: string, result: { ok: true; data: unknown } | { ok: false; error: string }) {
    this.send({ type: "reply", requestId, ...result });
  }

  /** Test hook: drop the socket without the usual close handshake, as a network fault would. */
  breakConnection() {
    this.ws?.terminate();
  }

  /** A message that is not journalled (BOS-316 check progress and results); the caller resends what matters on reconnect. */
  sendDirect(m: RunnerMessage | WorkerMessage) {
    this.send(m);
  }

  private send(m: RunnerMessage | WorkerMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private dial() {
    const ws = new WebSocket(this.opts.url, { headers: { authorization: `Bearer ${this.opts.token}` } });
    this.ws = ws;
    this.lastHeard = Date.now();

    ws.on("open", () => {
      this.attempt = 0;
      if (this.opts.checkWorker) this.helloAsWorker(this.opts.checkWorker);
      else this.helloAsRunner();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastHeard > this.heartbeatMs * 3) {
          this.opts.log?.("server silent for 3 heartbeats; reconnecting");
          ws.terminate();
          return;
        }
        this.send({ type: "ping" });
      }, this.heartbeatMs);
    });
    this.listen(ws);
  }

  private helloAsWorker(w: NonNullable<ConnectionOptions["checkWorker"]>) {
    const repos = w.repos?.();
    this.send({ type: "hello", protocol: PROTOCOL_VERSION, runnerVersion: this.opts.runnerVersion, imageVersion: this.opts.imageVersion ?? null, ...(this.opts.imageCommit ? { imageCommit: this.opts.imageCommit } : {}), ...(this.opts.toolchain ? { toolchain: this.opts.toolchain } : {}), features: [...w.features], bootId: this.bootId, checkSlots: w.slots, ...(this.opts.runningChecks ? { checkJobs: this.opts.runningChecks() } : {}), ...(repos?.length ? { repos } : {}) });
  }

  private helloAsRunner() {
    const pending = this.opts.pendingPermissions?.().slice(0, 500) ?? [];
    const liveRuns = this.opts.liveRuns?.();
    this.send({ type: "hello", protocol: PROTOCOL_VERSION, runnerVersion: this.opts.runnerVersion, imageVersion: this.opts.imageVersion ?? null, ...(this.opts.imageCommit ? { imageCommit: this.opts.imageCommit } : {}), ...(this.opts.toolchain ? { toolchain: this.opts.toolchain } : {}), ...(this.opts.harnessVersions ? { harnessVersions: this.opts.harnessVersions } : {}),features: [...RUNNER_FEATURES], bootId: this.bootId, ...(this.opts.restart?.previousExit ? { previousExit: this.opts.restart.previousExit } : {}), ...(this.opts.restart?.hostBootAt ? { hostBootAt: this.opts.restart.hostBootAt } : {}), ...(this.opts.runningChecks ? { checkJobs: this.opts.runningChecks() } : {}), ...(this.opts.checkSlots ? { checkSlots: this.opts.checkSlots } : {}),...(pending.length ? { pending } : {}), ...(liveRuns ? { liveRuns } : {}) });
  }

  private listen(ws: WebSocket) {
    ws.on("message", (raw) => {
      this.lastHeard = Date.now();
      let msg: ServerMessage;
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
        msg = ServerMessage.parse(data);
      } catch (err) {
        const issues = (err as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
        const why = issues ? issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(err);
        this.opts.log?.(`ignored a malformed server message: ${why}`);
        // A run start we can't read would otherwise sit at "starting" forever: say it ended.
        const cmd = (data as { type?: string; command?: { type?: string; runId?: unknown } } | undefined)?.command;
        if ((data as { type?: string } | undefined)?.type === "command" && cmd?.type === "run.start" && typeof cmd.runId === "string") {
          this.emit({ type: "run.ended", runId: cmd.runId, stopReason: null, error: `This runner couldn't read the run's start command (${why.slice(0, 300)}). The runner and server may be on different versions.` });
        }
        return;
      }
      switch (msg.type) {
        case "welcome": {
          const journal = this.opts.journal;
          if (this.opts.checkWorker || !journal) {
            // No journal to replay: only the undelivered check results go again.
            this.opts.onWelcome?.();
            this.live = true;
            return;
          }
          // The server already holds everything up to lastSeq. If that's beyond anything this
          // journal wrote, the journal is new, so its events are renumbered after the server's.
          if (msg.lastSeq > journal.lastSeq) {
            this.opts.log?.(`server has seq ${msg.lastSeq}, beyond this runner's journal (${journal.lastSeq}); numbering on from the server's`);
            journal.rebase(msg.lastSeq);
          }
          journal.ack(msg.lastSeq);
          if (msg.lastSeq < journal.ackedUpTo) {
            this.opts.log?.(`server has seq ${msg.lastSeq} but this runner compacted up to ${journal.ackedUpTo}; some events can't be replayed`);
          }
          for (const entry of journal.pending(msg.lastSeq)) this.send({ type: "event", entry });
          this.opts.onWelcome?.();
          this.live = true;
          return;
        }
        case "ack":
          this.opts.journal?.ack(msg.upTo);
          return;
        case "command":
          // A check worker acts on check commands only, whatever arrives (the server never sends it anything else).
          if (this.opts.checkWorker && !msg.command.type.startsWith("check.")) {
            this.opts.log?.(`ignored a ${msg.command.type} command: a check worker runs checks only`);
            return;
          }
          this.opts.onCommand(msg.command);
          return;
        case "ping":
          this.send({ type: "pong" });
          return;
        case "error":
          this.opts.log?.(`server error: ${msg.message}`);
          return;
        case "pong":
          return;
      }
    });

    ws.on("error", (err) => this.opts.log?.(`connection error: ${err.message}`));
    ws.on("close", () => {
      this.teardown();
      if (this.stopped) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempt++);
      this.retry = setTimeout(() => this.dial(), delay);
    });
  }

  private teardown() {
    this.live = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }
}
