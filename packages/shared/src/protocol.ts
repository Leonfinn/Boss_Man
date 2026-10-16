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
  /** Where the run is working (R38): the ticket's branch and the commit it started from. */
  z.object({ type: z.literal("run.workspace"), runId: Uuid, ticketId: Uuid, branch: z.string(), baseCommit: z.string(), created: z.boolean(), restoredPatch: z.boolean() }),
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
  z.object({
    type: z.literal("run.ended"),
    runId: Uuid,
    stopReason: z.string().nullable(),
    error: z.string().nullable(),
    /** The runner restarted while this run was going (R42); the server starts a recovery run. */
    interrupted: z.boolean().optional(),
  }),
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
    /** Recovery (R42): try to reopen this ACP session; start a fresh one if it can't be loaded. */
    resumeSessionId: z.string().optional(),
    /** Git workspace (R38): the run works in the ticket's worktree instead of cwd. */
    workspace: z.object({ projectId: Uuid, ticketId: Uuid, repoUrl: z.string(), baseRef: z.string() }).optional(),
  }),
  /** The ticket is finished with its worktree: save any uncommitted work and free it (R38). */
  z.object({ type: z.literal("workspace.release"), projectId: Uuid, ticketId: Uuid }),
  /** Asks for the ticket's changes against its base (R39). Answered with a reply, not an event. */
  z.object({ type: z.literal("workspace.diff"), requestId: z.string(), projectId: Uuid, ticketId: Uuid }),
  /** Runs the ticket's check in its worktree (R47). */
  z.object({ type: z.literal("workspace.verify"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, command: z.string().min(1) }),
  /** Merges the ticket's branch into a named target (R46). */
  z.object({ type: z.literal("workspace.merge"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, target: z.string().min(1), message: z.string().min(1) }),
  z.object({ type: z.literal("run.cancel"), runId: Uuid }),
  /** Steer a running agent (R37): the text is sent as the next prompt in the same session. With interrupt, the current turn is stopped first. */
  z.object({ type: z.literal("run.message"), runId: Uuid, text: z.string().min(1).max(20_000), interrupt: z.boolean() }),
  z.object({ type: z.literal("permission.decide"), runId: Uuid, requestId: z.string(), verdict: z.enum(["allow", "deny"]) }),
]);
export type RunnerCommand = z.infer<typeof RunnerCommand>;

/** Runner → server. */
export const RunnerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocol: z.number().int(), runnerVersion: z.string(), imageVersion: z.string().nullable() }),
  z.object({ type: z.literal("event"), entry: JournalEntry }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
  /** An answer to a request command. Not journalled: it can always be asked for again. */
  z.object({ type: z.literal("reply"), requestId: z.string(), ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() }),
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

/** What a ticket changed against its base (R39). */
export type WorkspaceDiff = {
  baseCommit: string;
  head: string;
  /** Commits on the ticket's branch since the base, newest first. */
  commits: Array<{ sha: string; subject: string }>;
  /** Files changed, with line counts, including uncommitted and untracked work. */
  files: Array<{ path: string; added: number; removed: number }>;
  diff: string;
  truncated: boolean;
};

/** The outcome of a ticket's check (R47). */
export type VerifyResult = { ok: boolean; exitCode: number | null; timedOut: boolean; output: string; ms: number };

/** The outcome of merging a ticket's branch (R46). */
export type MergeResult =
  | { status: "merged" | "already_merged"; commit: string }
  | { status: "conflicts"; files: string[] }
  | { status: "uncommitted"; files: string[] };
