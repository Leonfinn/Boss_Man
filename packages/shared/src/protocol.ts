// The runner ↔ server protocol (R31). The runner dials out over WebSocket with its
// bearer token; every event it sends carries a per-runner sequence number, is kept in
// the runner's journal until the server acknowledges it, and is replayed after a
// reconnect. The server stores events idempotently by (runner, seq).
import { z } from "zod";
import { RUN_MESSAGE_MAX } from "./owner-message.js";

export const PROTOCOL_VERSION = 1;

/** Both sides ping at this interval and drop a connection silent for 3 intervals. */
export const HEARTBEAT_MS = 15_000;

const Uuid = z.string().uuid();

export const GuardReport = z.object({
  /** on: a connect to the runner's own default gateway was refused at once with EHOSTUNREACH (the guard). absent: it connected, timed out, was refused or there was no gateway. */
  state: z.enum(["on", "absent"]),
  reason: z.string().max(200),
  errno: z.string().max(100).nullable(),
  ms: z.number().nonnegative(),
});
export type GuardReport = z.infer<typeof GuardReport>;

/**
 * What a runner can fence agents with (DR-004, BOS-321), from its start-up self-test. full: Landlock
 * ABI 6+; partial: ABI 2-5, files fenced but `missing` lists what isn't; unavailable: no usable
 * Landlock (errno says why: ENOSYS not built or blocked, EOPNOTSUPP switched off at boot).
 * probe: a fenced write outside its folder was refused and one inside worked (null if not tried).
 */
export const SandboxReport =z.object({
  /** The runner's own network-guard probe (DR-049 point 2); absent on a runner that predates it. */
  guard: GuardReport.optional(),
  landlockAbi: z.number().int().nonnegative(),
  errno: z.string().max(200).nullable(),
  level: z.enum(["full", "partial", "unavailable"]),
  missing: z.array(z.string().max(100)).max(10),
  /** Unprivileged user namespaces (what bubblewrap needs); for information only: nothing uses them, and runs are kept apart by Landlock, not namespaces (BOS-555). */
  userns: z.boolean(),
  probe: z.boolean().nullable(),
});
export type SandboxReport = z.infer<typeof SandboxReport>;

export const RunnerEvent = z.discriminatedUnion("type", [
  /**
   * resumed: the run reopened the session it was asked to (resumeSessionId), rather than starting fresh.
   * fenced: the agent runs inside the fence (run.start's fence, on a runner that can fence).
   */
  z.object({ type: z.literal("run.started"), runId: Uuid, agentId: Uuid.nullable(), acpSessionId: z.string(), model: z.string().nullable(), resumed: z.boolean().optional(), fenced: z.boolean().optional() }),
  /** How full the session's context is, in tokens (from ACP usage_update). */
  z.object({ type: z.literal("run.context"), runId: Uuid, used: z.number().int().nonnegative(), size: z.number().int().positive() }),
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
    /** Text the agent attached to the request, e.g. the plan when it asks to leave plan mode (R40). */
    detail: z.string().max(20_000).optional(),
    /** The agent's id for the tool call, so two requests for one call (OpenCode asks for a folder, then the command) can be told apart from a repeat. */
    toolCallId: z.string().max(200).optional(),
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
    /** Tokens over every turn of the run, when the agent reports them (R67). */
    usage: z
      .object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cachedReadTokens: z.number().int().nonnegative(), cachedWriteTokens: z.number().int().nonnegative() })
      .optional(),
  }),
  z.object({ type: z.literal("runner.log"), level: z.enum(["info", "warn", "error"]), message: z.string() }),
  // The models an agent kind offers, from its ACP session's model option (R60).
  z.object({
    type: z.literal("runner.models"),
    agentKind: z.string().min(1).max(40),
    models: z.array(z.object({ value: z.string().min(1).max(200), name: z.string().max(200), description: z.string().max(500).nullable().optional() })).max(1000),
  }),
  // Disk use of the runner's workspaces after its clean-up pass (R54).
  z.object({
    type: z.literal("runner.disk"),
    usedBytes: z.number().nonnegative(),
    tickets: z.array(z.object({ ticketId: Uuid, projectId: Uuid, bytes: z.number().nonnegative() })),
    repos: z.array(z.object({ projectId: z.string(), bytes: z.number().nonnegative() })),
    /** Each ticket's kept scratch (BOSSMAN_SCRATCH, BOS-592); absent from an older runner. */
    scratch: z.array(z.object({ ticketId: Uuid, bytes: z.number().nonnegative() })).optional(),
    /** Ticket folders git no longer knew about (or scratch folders past their keep), removed in this pass. */
    removed: z.array(z.string()),
  }),
  // The OpenCode prune's one-off VACUUM ran past its cap and was killed, letting held OpenCode runs go (BOS-622).
  z.object({
    type: z.literal("runner.opencode_vacuum_cut"),
    heldSeconds: z.number().int().nonnegative().max(86_400),
    bytes: z.number().nonnegative(),
    agentHome: z.boolean(),
  }),
  // The runner's start-up self-test of the agent fence (BOS-321).
  z.object({ type: z.literal("runner.sandbox"), report: SandboxReport }),
]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;
export type DiskReport = Omit<Extract<RunnerEvent, { type: "runner.disk" }>, "type">;

export const JournalEntry = z.object({ seq: z.number().int().positive(), at: z.string(), event: RunnerEvent });
export type JournalEntry = z.infer<typeof JournalEntry>;

/** Thinking levels an agent can ask for; the adapter's thought_level option says which its model takes. */
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const RunnerCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run.start"),
    runId: Uuid,
    agentId: Uuid,
    agentKind: z.string(),
    /** The agent's display name now, for the git author of any commit the run makes (BOS-265); an older runner ignores it and uses "Boss Man". */
    agentName: z.string().min(1).max(200).optional(),
    model: z.string().nullable(),
    /** The agent's thinking level (THINKING_LEVELS); an older runner ignores it. */
    thinking: z.string().optional(),
    fundingSourceId: Uuid.nullable(),
    cwd: z.string(),
    prompt: z.string(),
    /** Per-session MCP bearer token for the Boss Man MCP server. */
    mcpToken: z.string(),
    /**
     * This run needs the Boss Man tools: a runner that can't reach them fails the run instead of
     * starting it blind (BOS-552). An older runner strips it and behaves as before.
     */
    mcpRequired: z.boolean().optional(),
    /** Recovery (R42): try to reopen this ACP session; start a fresh one if it can't be loaded. */
    resumeSessionId: z.string().optional(),
    /** The prompt to send instead if resumeSessionId can't be reopened, so a fresh session still gets its full context. */
    freshPrompt: z.string().optional(),
    /** No built-in tools (files, shell, web): only the Boss Man MCP tools. For the owner chat. */
    boardToolsOnly: z.boolean().optional(),
    /** Start in plan mode (R40): the agent plans and asks for approval before changing anything. */
    mode: z.enum(["plan"]).optional(),
    /** Git workspace (R38): the run works in the ticket's worktree instead of cwd. */
    workspace: z.object({ projectId: Uuid, ticketId: Uuid, repoUrl: z.string(), baseRef: z.string(), review: z.boolean().optional() }).optional(),
    /** The company's extra MCP servers. Only the name of the secret travels, never its value; an older runner ignores this. */
    mcpServers: z
      .array(z.object({ name: z.string(), url: z.string(), transport: z.enum(["http", "sse"]), headerName: z.string(), headerValue: z.string(), secretEnv: z.string().nullable() }))
      .max(50)
      .optional(),
    /** The agent's skills (R71): Agent Skills folders, file contents in base64. Matches the server's per-skill file limit. */
    skills: z
      .array(z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string() })).max(1000) }))
      .max(100)
      .optional(),
    /**
     * Run the agent inside the fence (DR-004, BOS-321). A runner that can't fence refuses the run with
     * FENCE_UNAVAILABLE_ERROR (BOS-373), except a boardToolsOnly run, which starts unfenced and says so
     * (run.started's fenced); one without the "fence" feature ignores it.
     */
    fence: z.boolean().optional(),
  }),
  /** The ticket is finished with its worktree: save any uncommitted work and free it (R38). */
  z.object({ type: z.literal("workspace.release"), projectId: Uuid, ticketId: Uuid }),
  /**
   * Asks for the ticket's changes against its base (R39). Answered with a reply, not an event. With
   * `baseRef` (the project's default branch) the runner measures them from the merge-base of its
   * recorded base and a freshly fetched origin/<baseRef>, so a branch that has merged main since it
   * started shows only its own changes (BOS-694). Without it, or when origin can't be reached, the
   * recorded base stands.
   */
  z.object({ type: z.literal("workspace.diff"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, range: z.enum(["base", "last_turn"]).optional(), baseRef: z.string().min(1).max(200).optional() }),
  /** Reads one file of a ticket's work: its worktree if it has one here, else its branch (R77). */
  z.object({ type: z.literal("workspace.file"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, path: z.string().min(1).max(500) }),
  /** An image (a screenshot) from the ticket's working folder, to attach to the ticket; the reply carries it as base64. */
  z.object({ type: z.literal("workspace.image"), requestId: z.string(), ticketId: Uuid, path: z.string().min(1).max(500) }),
  /** Runs the ticket's check in its worktree (R47). */
  /**
   * fence: run the check inside the fence (BOS-323), like run.start's. A runner that can't fence runs
   * it as before and says so (VerifyResult.fenced); an older runner ignores it.
   */
  z.object({ type: z.literal("workspace.verify"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, command: z.string().min(1), fence: z.boolean().optional(), scanList: z.string().max(60_000).optional() }),
  /** Whether the ticket's new migration numbers are free (BOS-219), against the default branch and these other branches. */
  z.object({ type: z.literal("workspace.migrations"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, target: z.string().min(1), others: z.array(z.string().min(1)).max(50) }),
  /** Whether the ticket's branch still merges into the target, without merging it (BOS-426). */
  z.object({ type: z.literal("workspace.clash"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, target: z.string().min(1) }),
  /** Whether the owner's sign-off on commit `signed` still covers the branch head: only clean automatic merges of the target came in since (BOS-734, DR-038). */
  z.object({ type: z.literal("workspace.covers"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, target: z.string().min(1), signed: z.string().regex(/^[0-9a-f]{7,64}$/), head: z.string().regex(/^[0-9a-f]{7,64}$/).optional() }),
  /** Merges the ticket's branch into a named target (R46). */
  z.object({ type: z.literal("workspace.merge"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, target: z.string().min(1), message: z.string().min(1), checks: z.array(z.string().min(1)).max(5).optional(), phase: z.enum(["prepare", "finish", "publish", "unpublish"]).optional(), commit: z.string().min(7).optional(), tree: z.string().min(7).optional(), expectTree: z.string().min(7).optional(),
    /** Merge train (BOS-1366, runner feature "merge-base"): prepare on this commit (main's tip or a train member ahead) instead of main's tip. */
    base: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    /** Merge train: finish pushes only if main's tip is exactly this commit, the base the checked tree was prepared on. */
    expectBase: z.string().regex(/^[0-9a-f]{40}$/).optional() }),
  /** Propose merge checks from the repo's files on its default branch, and say which tools the runner has (R57). */
  z.object({ type: z.literal("workspace.detect"), requestId: z.string(), projectId: Uuid, repoUrl: z.string().min(1), baseRef: z.string().min(1) }),
  /** Push the ticket's branch for a pull request into target, after the same checks as a merge (R59). */
  z.object({ type: z.literal("workspace.push"), requestId: z.string(), projectId: Uuid, ticketId: Uuid, target: z.string().min(1) }),
  /**
   * Which other open tickets' unmerged commits this ticket's branch carries (BOS-130), so a merge
   * can't put code on the target that nobody approved yet.
   */
  z.object({
    type: z.literal("workspace.carried"),
    requestId: z.string(),
    projectId: Uuid,
    ticketId: Uuid,
    target: z.string().min(1),
    branches: z.array(z.object({ ticketId: Uuid, branch: z.string().min(1) })).max(500),
  }),
  /**
   * What a deploy's ref is (DR-033): the commit it resolves to after a fetch, whether that commit is on the
   * base branch, and the remote's branch names (so a deploy tag can't take a branch's name). Read-only.
   */
  z.object({ type: z.literal("workspace.resolve"), requestId: z.string(), projectId: Uuid, repoUrl: z.string().min(1), ref: z.string().min(1).max(200), baseRef: z.string().min(1) }),
  /**
   * Move a deploy target's tag to the commit a deploy shipped (DR-033). The daemon checks the name and the
   * commit again, builds the refspec itself and pushes with a lease; it never deletes and never touches a branch.
   */
  z.object({ type: z.literal("workspace.tag"), requestId: z.string(), projectId: Uuid, repoUrl: z.string().min(1), name: z.string().min(1).max(100), commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/), baseRef: z.string().min(1) }),
  /** Prove the company's Claude setup-token works with one tiny prompt (R58). The runner fetches the token itself. */
  z.object({ type: z.literal("credential.check"), requestId: z.string() }),
  /** Ask an agent kind for its model list without sending a prompt: a throwaway ACP session, closed at once. */
  z.object({ type: z.literal("models.probe"), requestId: z.string(), agentKind: z.enum(["claude", "codex", "opencode"]) }),
  /** Check the runner's add-ons (docs/12); answered with AddonReport[]. Sent only to runners with the "addons" feature. */
  z.object({ type: z.literal("addons.check"), requestId: z.string() }),
  /**
   * Run a queued check job (DR-003, BOS-316) in a process the runner owns, in its own detached worktree of this exact commit.
   * It is not tied to any agent session. Answered with check.progress and check.done messages, not a reply.
   */
  z.object({ type: z.literal("check.run"), jobId: Uuid, projectId: Uuid, ticketId: Uuid, commit: z.string().min(7).max(64), command: z.string().min(1), timeoutMs: z.number().int().positive().optional(), scanList: z.string().max(60_000).optional() }),
  /** Stop a check job. Only the server sends this; agents have no way to. */
  z.object({ type: z.literal("check.cancel"), jobId: Uuid }),
  /** The server has recorded this job’s result; the runner can stop re-sending it. */
  z.object({ type: z.literal("check.ack"), jobId: Uuid }),
  z.object({ type: z.literal("run.cancel"), runId: Uuid }),
  /**
   * Steer a running agent (R37): the text is sent as the next prompt in the same session. With interrupt, the current
   * turn is stopped first. The max leaves room for the prefix the server adds to a longest-allowed owner message (BOS-502).
   * With steer, an agent that supports ACP steering gets it inside the running turn instead, without a cancel (BOS-1016);
   * others queue it as usual. Optional, so either side can be older.
   */
  z.object({ type: z.literal("run.message"), runId: Uuid, text: z.string().min(1).max(RUN_MESSAGE_MAX), interrupt: z.boolean(), steer: z.boolean().optional() }),
  z.object({ type: z.literal("permission.decide"), runId: Uuid, requestId: z.string(), verdict: z.enum(["allow", "deny"]) }),
]);
export type RunnerCommand = z.infer<typeof RunnerCommand>;

/** Harness name to exact version, e.g. { "claude-code": "2.1.0" }. */
export const HarnessVersions = z.record(z.string().max(40), z.string().max(60));
export type HarnessVersions = z.infer<typeof HarnessVersions>;

/** Runner → server. */
export const RunnerMessage = z.discriminatedUnion("type", [
  /**
   * pending: permission requests this runner is still waiting on. A verdict can be lost if the
   * socket drops just after the server sends it, so the server answers these again.
   */
  z.object({
    type: z.literal("hello"),
    protocol: z.number().int(),
    runnerVersion: z.string(),
    imageVersion: z.string().nullable(),
    /** The git commit this image was built from (BOS-764); absent from an image built before it was recorded. */
    imageCommit: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
    /** Versions of the agent harnesses in this runner's image, by name (BOS-305); absent from an older runner. */
    harnessVersions: HarnessVersions.optional(),
    /** What this runner can do beyond the base protocol, so a newer server asks an older runner only for what it knows. */
    features: z.array(z.string().max(40)).max(50).optional(),
    /** New for every runner process start (BOS-352), so the server can tell a restart from a reconnect; absent from an older runner. */
    bootId: z.string().max(100).optional(),
    /** How the previous runner process ended (BOS-594): told to stop (SIGTERM) or not (a crash or out of memory); absent on a first start or from an older runner. */
    previousExit: z.enum(["stopped", "crashed"]).optional(),
    /** When the host machine booted (ISO time), so the server can tell a host restart (BOS-594); absent from an older runner. */
    hostBootAt: z.string().max(40).optional(),
    /** The ids of every run this runner really has (BOS-583); the server closes any other open run of this runner. Absent from an older runner: the server then closes nothing. */
    liveRuns: z.array(Uuid).max(2000).optional(),
    pending: z.array(z.object({ runId: Uuid, requestId: z.string().max(100) })).max(500).optional(),
    /** Check jobs this runner is running now (BOS-316): the server puts back in line any it thinks run here but are not listed. */
    checkJobs: z.array(Uuid).max(100).optional(),
  }),

  z.object({ type: z.literal("event"), entry: JournalEntry }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("pong") }),
  /** A running check job printed something: the log tail so far (BOS-316). */
  z.object({ type: z.literal("check.progress"), jobId: Uuid, tail: z.string().max(20_000) }),
  /** A check job ended (BOS-316). commit is the commit that was checked; the server ignores an answer for any other. */
  z.object({ type: z.literal("check.done"), jobId: Uuid, commit: z.string().max(64), exitCode: z.number().int().nullable(), timedOut: z.boolean(), tail: z.string().max(20_000), fullLog: z.string().max(2_000_000).optional() }),
  /** An answer to a request command. Not journalled: it can always be asked for again. */
  z.object({ type: z.literal("reply"), requestId: z.string(), ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() }),
]);
export type RunnerMessage = z.infer<typeof RunnerMessage>;

/** Runner features (hello.features). "review-copy": run.start's workspace.review gives a reviewer its own copy. "addons": answers addons.check (docs/12). "carried-check": answers workspace.carried (BOS-130). "fence": honours run.start's fence and sends runner.sandbox (BOS-321). "check-jobs": runs server-queued checks (DR-003). "clash-check": answers workspace.clash (BOS-426). "signoff-covers": answers the sign-off covers check. "deploy-tag": answers workspace.resolve and workspace.tag (DR-033). "ci-publish": workspace.merge's "publish" and "unpublish" phases and its expectTree (BOS-1070); an older runner would read an unknown phase as a plain merge, so the server only sends them to a runner that says this. "merge-base": honours workspace.merge's base and expectBase (BOS-1366; an older runner's zod would silently drop them). */
export const RUNNER_FEATURES = ["review-copy", "addons", "carried-check", "fence", "check-jobs", "clash-check", "signoff-covers", "deploy-tag", "ci-publish", "merge-base"] as const;

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
  /** The tree of head: two commits with one tree are the same code (check results are reused by it). */
  tree?: string;
  /** Commits on the ticket's branch since the base, newest first. */
  commits: Array<{ sha: string; subject: string }>;
  /** Files changed, with line counts, including uncommitted and untracked work. */
  files: Array<{ path: string; added: number; removed: number }>;
  diff: string;
  truncated: boolean;
  /** For a last-turn diff: which checkpoint it ends at, and when that was taken. */
  turn?: { number: number; at: string };
};

/** The outcome of a ticket's check (R47). */
/** fenced: set only when the check was asked to run fenced, saying whether it was. */
export type VerifyResult = { ok: boolean; exitCode: number | null; timedOut: boolean; output: string; ms: number; fenced?: boolean; /** BOS-1228: the whole log of a server-queued job, cut and redacted by the runner (see prepareFullLog). */ fullLog?: string; /** BOS-1228: set by the server when the failed job's whole log is kept (read with the check_log tool). */ keptLog?: { jobId: string; chars: number; ticketId: string } };
/**
 * A ticket's kept scratch (BOSSMAN_SCRATCH, BOS-592): one folder per ticket on the workspaces disk, so a proof
 * or a check log outlives the runner and the temp sweep. Kept a week, or a few hours once the ticket's work is gone.
 */
export const SCRATCH_KEEP_MS = 7 * 24 * 60 * 60_000;
export const RELEASED_SCRATCH_KEEP_MS = 6 * 60 * 60_000;
/**
 * How long the runner lets a ticket's check run (R47), counted from when it actually starts. A check that is waiting
 * in scripts/check-all.sh's queue is given up to VERIFY_QUEUE_MAX_MS to reach the front first; the server waits for
 * the answer a minute longer than both.
 */
export const VERIFY_TIMEOUT_MS = 60 * 60_000;
export const VERIFY_QUEUE_MAX_MS = 90 * 60_000;
/**
 * VERIFY_QUEUE_MAX_MS is a no-progress limit (BOS-370): the runner restarts it every time the check's place in the queue
 * changes, so a long queue that keeps moving never trips it; scripts/check-all.sh gives up sooner (an hour) on its own.
 * The server's wait is only a ceiling for a queue that moves for a very long time.
 */
export const VERIFY_QUEUE_CEILING_MS = 24 * 60 * 60_000;
export const VERIFY_ASK_TIMEOUT_MS = VERIFY_QUEUE_CEILING_MS + VERIFY_TIMEOUT_MS + 60_000;
/** What scripts/check-all.sh prints while it waits for a slot, and when it gets one; the runner starts the run clock (VERIFY_TIMEOUT_MS) at the second, never earlier. */
export const CHECK_QUEUED_MARKER = "check-all: waiting for a free check slot";
export const CHECK_STARTED_MARKER = "check-all: slot taken, running the checks";
/**
 * How long an approved ticket can go without any activity before its merge is treated as stopped:
 * longer than a check runs, so a check still running is never mistaken for one that died. A check waiting
 * in the queue beats every minute (whileActive), so it can wait for hours without tripping this. The unmerged-approvals sweep and the merge card's stale marker both use it.
 */
export const MERGE_MISSED_AFTER_MS = VERIFY_TIMEOUT_MS + 60_000 + 5 * 60_000;

/** Proposed merge checks, and which of CHECK_TOOLS the runner has (R57). */
export type DetectResult = { checks: import("./checks.js").CheckPreset[]; tools: Record<string, boolean> };

/** The outcome of merging a ticket's branch (R46). */
export type MigrationRenamed = { from: string; to: string };

/**
 * The branch the merge gate publishes a ticket's merge commit to for the git host's CI (BOS-1070). Not bossman/<id>:
 * the runner fetches every origin branch into the agents' view, and there that name is the ticket's own branch.
 */
export const ciBranchFor = (ticketId: string) => `bossman-ci/${ticketId}`;

/**
 * The ticket's copy holds changes its branch doesn't (R46). `files` are the author's to commit. `foreign` (BOS-1231): the
 * copy fell behind its own branch (the branch moved on from another folder) and couldn't be moved up safely; these files
 * differ only because the branch moved on, so they are never the author's to commit. While any are there, the CEO is
 * told instead of the author.
 */
export type Uncommitted = { status: "uncommitted"; files: string[]; foreign?: string[] };

export type MergeResult =
  /** Server-queued merge check, phase "prepare" (BOS-316): the merge commit is built and kept, not pushed. */
  | { status: "prepared"; commit: string; tree: string; targetSha: string; renamed?: MigrationRenamed[] }
  /**
   * Phase "publish" (BOS-1070): the prepared merge commit was force-pushed to `branch` (bossman-ci/<ticket>) so the git host's
   * CI tests exactly what would land. `hasWorkflows` false: the commit has no .github/workflows, so nothing was pushed and no CI will run.
   */
  | { status: "published"; branch: string; commit: string; hasWorkflows: boolean }
  /** Phase "unpublish": the CI branch is gone from origin (or was never there). */
  | { status: "unpublished"; branch: string }
  /** `renamed`: the gate renumbered the branch's migrations itself (BOS-690): the SQL is unchanged, only the name and journal line moved. */
  | { status: "merged"; commit: string; checked?: { sha: string; tree: string; ms: number }; renamed?: MigrationRenamed[] }
  | { status: "already_merged"; commit: string }
  | { status: "conflicts"; files: string[] }
  | Uncommitted
  /** The merged journal would make drizzle skip a migration (BOS-360); `problems` ends with what to do. */
  | { status: "migration_journal"; problems: string[] }
  /** Asked to check the merged result (BOS-313): a check failed on the merge commit, so nothing was pushed. */
  | { status: "check_failed"; command: string; result: VerifyResult }
  /** The target kept moving while its merged result was checked; nothing was pushed, try again. */
  | { status: "main_moved" };

/** Another open ticket whose unmerged commits a ticket's branch carries (BOS-130). */
/** `contained`: this ticket's branch holds the other branch's whole tip, so merging this one lands it too (BOS-372). */
export type CarriedTicket = { ticketId: string; branch: string; contained?: boolean };

/** The answer to workspace.carried: the other tickets whose unmerged commits this branch has. */
export type CarriedResult = { carried: CarriedTicket[] };

/** The outcome of pushing a ticket's branch for a pull request (R59). */
export type PushResult = { status: "pushed"; branch: string; commit: string } | { status: "already_merged"; commit: string } | { status: "conflicts"; files: string[] } | Uncommitted;

/** The answer to workspace.resolve (DR-033). `commit` is null when the ref names no commit (an image tag, say). */
export type ResolveResult = { commit: string | null; onBase: boolean; branches: string[]; error?: string };

/**
 * The answer to workspace.tag (DR-033). moved: the remote tag now points at `to` (`from` is null when it was new).
 * unchanged: it already did. refused: a check failed before any push. failed: the push was refused, or the tag
 * was moved by someone else meanwhile (it is left where they put it). `error` carries the reason or git's text.
 */
export type TagResult = { result: "moved" | "unchanged" | "refused" | "failed"; from: string | null; to: string; error?: string };

/** A deploy tag name (DR-033): one ref component, so never a path, and nothing git's check-ref-format refuses. */
export function deployTagNameProblem(name: string): string | null {
  if (!name) return "Give a tag name.";
  if (name.length > 100) return "Keep the tag name to 100 characters or fewer.";
  if (name.includes("/")) return "The tag name can't contain '/'.";
  if (name.startsWith("-") || name.startsWith(".")) return "The tag name can't start with '-' or '.'.";
  if (name.endsWith(".") || name.endsWith(".lock")) return "The tag name can't end with '.' or '.lock'.";
  if (name === "@" || name.includes("..") || name.includes("@{")) return "The tag name can't be '@' or contain '..' or '@{'.";
  // Control characters, space and the characters git keeps for revision syntax.
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return "The tag name can't contain spaces or any of ~ ^ : ? * [ \\.";
  if (name.toUpperCase() === "HEAD") return "The tag name can't be HEAD.";
  return null;
}

/**
 * Whether a deploy ref is safe to hand to git rev-parse (DR-033): a branch, tag or sha shape, never an option.
 * Anything else (an image tag with odd characters, say) simply isn't resolved.
 */
export const DEPLOY_REF = /^[A-Za-z0-9_][A-Za-z0-9._/+-]{0,199}$/;

/**
 * Whether a ticket's new migrations take a number another branch already has (BOS-219).
 * `needed: false` means the branch is fine, `needed: true` gives the number to move to now, and
 * `needed: null` means the check couldn't say (fetch the branch, or say why): it never blocks work.
 */
export type MigrationsResult =
  | { needed: false; reason: string }
  | { needed: true; number: number; next: number; why: string[]; others: string[] }
  | { needed: null; reason: string };

/**
 * The company's agent fence setting (BOS-325): off, watch (default for new companies since BOS-940: agents run
 * fenced and refusals are logged) or enforce. "enforce" is not selectable yet: it waits for BOS-323's git fix, so the server refuses it.
 */
export const FENCE_MODES = ["off", "watch", "enforce"] as const;
export type FenceMode = (typeof FENCE_MODES)[number];
/** What Off means, in BOS-373's words, said wherever the owner chooses Off (BOS-940): Settings and the fence card. */
export const FENCE_OFF_CONSEQUENCE = "With the fence Off, agents can read the runner's key and this company's git login.";
/**
 * Why a runner ends a run asked to be fenced that it can't fence (BOS-373, DR-047), instead of starting it unfenced.
 * The server holds such a company's work as soon as it sees the runner's report, so this covers the gap before that.
 */
export const FENCE_UNAVAILABLE_ERROR =
  "This run was asked to run inside the agent fence, but this runner can't fence agents, so it didn't start: unfenced, an agent could read the runner's key and this company's git login. It runs again once the host can fence, or after the owner chooses Off (Settings → Permissions → Agent fence).";
/** Flip once BOS-323 is merged and its test shows the git gap closed. */
export const FENCE_ENFORCE_AVAILABLE = false;
/** Tool output a fenced agent gets when the kernel refuses it (Landlock gives EACCES or EPERM, nothing else). */
export const FENCE_DENIED_PATTERN = /Permission denied|Operation not permitted|\bEACCES\b|\bEPERM\b/i;
