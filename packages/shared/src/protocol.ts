// The runner ↔ server protocol (R31). The runner dials out over WebSocket with its
// bearer token; every event it sends carries a per-runner sequence number, is kept in
// the runner's journal until the server acknowledges it, and is replayed after a
// reconnect. The server stores events idempotently by (runner, seq).
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Both sides ping at this interval and drop a connection silent for 3 intervals. */
export const HEARTBEAT_MS = 15_000;

const Uuid = z.string().uuid();

export const RunnerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), runId: Uuid, agentId: Uuid.nullable(), acpSessionId: z.string(), model: z.string().nullable() }),
  z.object({ type: z.literal("run.update"), runId: Uuid, update: z.unknown() }),
  z.object({
    type: z.literal("run.permission_request"),
    runId: Uuid,
    requestId: z.string(),
    title: z.string().nullable(),
    kind: z.string().nullable(),
    rawInput: z.unknown(),
    optionKinds: z.array(z.string()),
  }),
  z.object({
    type: z.literal("run.cost"),
    runId: Uuid,
    fundingSourceId: Uuid,
    /** The increase since the previous report for this ACP session (R34). */
    costMicrosDelta: z.number().int().nonnegative(),
    model: z.string().nullable(),
  }),
  z.object({ type: z.literal("run.quota"), fundingSourceId: Uuid, claudeMeta: z.unknown().optional(), codexRateLimits: z.unknown().optional() }),
  z.object({ type: z.literal("run.ended"), runId: Uuid, stopReason: z.string().nullable(), error: z.string().nullable() }),
  z.object({ type: z.literal("runner.log"), level: z.enum(["info", "warn", "error"]), message: z.string() }),
]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;

export const JournalEntry = z.object({ seq: z.number().int().positive(), at: z.string(), event: RunnerEvent });
export type JournalEntry = z.infer<typeof JournalEntry>;

export const RunnerCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run.start"),
    runId: Uuid,
    agentId: Uuid,
    agentKind: z.string(),
    model: z.string().nullable(),
    fundingSourceId: Uuid.nullable(),
    cwd: z.string(),
    prompt: z.string(),
    /** Per-session MCP bearer token for the Boss Man MCP server. */
    mcpToken: z.string(),
  }),
  z.object({ type: z.literal("run.cancel"), runId: Uuid }),
  z.object({ type: z.literal("permission.decide"), runId: Uuid, requestId: z.string(), verdict: z.enum(["allow", "deny"]) }),
]);
export type RunnerCommand = z.infer<typeof RunnerCommand>;

/** Runner → server. */
export const RunnerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocol: z.number().int(), runnerVersion: z.string(), imageVersion: z.string().nullable() }),
  z.object({ type: z.literal("event"), entry: JournalEntry }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
]);
export type RunnerMessage = z.infer<typeof RunnerMessage>;

/** Server → runner. */
export const ServerMessage = z.discriminatedUnion("type", [
  /** Sent after hello: the highest seq the server already holds, so the runner replays the rest. */
  z.object({ type: z.literal("welcome"), lastSeq: z.number().int().nonnegative() }),
  /** Cumulative: every seq up to and including this one is stored. */
  z.object({ type: z.literal("ack"), upTo: z.number().int().nonnegative() }),
  z.object({ type: z.literal("command"), id: z.string(), command: RunnerCommand }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
