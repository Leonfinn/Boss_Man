// The runner's link to the Boss Man server (R31): dial out, say hello, replay what the
// server hasn't stored, then stream live. Reconnects with backoff; a connection that
// goes quiet for three heartbeats is dropped and redialled.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { HEARTBEAT_MS, PROTOCOL_VERSION, RUNNER_FEATURES, ServerMessage, type HarnessVersions, type RunnerCommand, type RunnerEvent, type RunnerMessage } from "@boss-man/shared";
import type { Journal } from "./journal.js";

export type ConnectionOptions = {
  url: string;
  token: string;
  journal: Journal;
  onCommand: (command: RunnerCommand) => void;
  runnerVersion: string;
  imageVersion?: string | null;
  /** Versions of the harnesses in the image, told to the server in hello (BOS-305). */
  harnessVersions?: HarnessVersions;
  heartbeatMs?: number;
  log?: (msg: string) => void;
  /** Permission requests still waiting for a verdict, re-asked on every (re)connect. */
  pendingPermissions?: () => Array<{ runId: string; requestId: string }>;
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

  private send(m: RunnerMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private dial() {
    const ws = new WebSocket(this.opts.url, { headers: { authorization: `Bearer ${this.opts.token}` } });
    this.ws = ws;
    this.lastHeard = Date.now();

    ws.on("open", () => {
      this.attempt = 0;
      const pending = this.opts.pendingPermissions?.().slice(0, 500) ?? [];
      this.send({ type: "hello", protocol: PROTOCOL_VERSION, runnerVersion: this.opts.runnerVersion, imageVersion: this.opts.imageVersion ?? null, ...(this.opts.harnessVersions ? { harnessVersions: this.opts.harnessVersions } : {}),features: [...RUNNER_FEATURES], bootId: this.bootId, ...(pending.length ? { pending } : {}) });
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastHeard > this.heartbeatMs * 3) {
          this.opts.log?.("server silent for 3 heartbeats; reconnecting");
          ws.terminate();
          return;
        }
        this.send({ type: "ping" });
      }, this.heartbeatMs);
    });

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
          // The server already holds everything up to lastSeq. If that's beyond anything this
          // journal wrote, the journal is new, so its events are renumbered after the server's.
          if (msg.lastSeq > this.opts.journal.lastSeq) {
            this.opts.log?.(`server has seq ${msg.lastSeq}, beyond this runner's journal (${this.opts.journal.lastSeq}); numbering on from the server's`);
            this.opts.journal.rebase(msg.lastSeq);
          }
          this.opts.journal.ack(msg.lastSeq);
          if (msg.lastSeq < this.opts.journal.ackedUpTo) {
            this.opts.log?.(`server has seq ${msg.lastSeq} but this runner compacted up to ${this.opts.journal.ackedUpTo}; some events can't be replayed`);
          }
          for (const entry of this.opts.journal.pending(msg.lastSeq)) this.send({ type: "event", entry });
          this.live = true;
          return;
        }
        case "ack":
          this.opts.journal.ack(msg.upTo);
          return;
        case "command":
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
