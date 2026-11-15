// Runner registration, authentication and event ingestion (R31).
import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, like, lt, max, sql } from "drizzle-orm";
import { z } from "zod";
import { AddonReport, isInfiniteModel, type JournalEntry, type RUNNER_FEATURES, type RunnerCommand, type RunnerEvent, type SandboxReport } from "@boss-man/shared";
import { hashToken } from "../auth.js";
import type { Db } from "../db/client.js";
import { record } from "./activity.js";
import { recordRestart, type HelloRestart, type LastRestart } from "./runner-restarts.js";
import { redact } from "./error-buffer.js";
import { costEvents, decisions, engagements, notifications, runnerEventAttempts, runnerEvents, runners, runs, runTokens, settings, tickets } from "../db/schema.js";
import type { fundingService } from "./funding.js";

/** How many times one event may fail with an unexplained (uncoded) error before it is stored, marked and acked (BOS-606). */
const MAX_APPLY_ATTEMPTS = 3;

/** A run started this recently may not be on the runner's list yet; and the wait before the list is acted on lets the runner replay what it finished while offline (BOS-583). */
export const LIVE_RUNS_GRACE_MS = 60_000;

type Runner = typeof runners.$inferSelect;
/** The transaction handle drizzle passes to `db.transaction`, so apply steps share the ingest transaction. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/**
 * The runner a request went to has gone away (it disconnected or restarted), so no reply will ever come (DR-014).
 * Callers that run long work on a runner treat this as the host being cut off, not the work failing.
 */
export class RunnerGone extends Error {
  constructor(message = "The runner restarted while this was running.") {
    super(message);
    this.name = "RunnerGone";
  }
}

export type CommandSender = (command: RunnerCommand) => boolean;

export type PermissionHook = (runner: Runner, event: Extract<RunnerEvent, { type: "run.permission_request" }>) => Promise<unknown>;

/** How long after a runner connects its queued runs are still starting up. */
export const RUNNER_SETTLE_MS = 10 * 60_000;

export function runnersService(db: Db, funding: ReturnType<typeof fundingService>) {
  let onPermission: PermissionHook | null = null;
  const listeners: Array<(runner: Runner, event: RunnerEvent) => void> = [];
  // Runs before listeners and is awaited, for cheap bookkeeping a reader must see straight after the event (BOS-217).
  const syncHooks: Array<(runner: Runner, event: RunnerEvent) => Promise<unknown>> = [];
  const connectListeners: Array<(runnerId: string) => unknown> = [];
  const restartListeners: Array<(runner: Runner, last: LastRestart) => unknown> = [];
  const lostListeners: Array<(runId: string) => unknown> = [];
  let liveRunsDelayMs = LIVE_RUNS_GRACE_MS;
  const resumeListeners: Array<(runner: Runner, pending: Array<{ runId: string; requestId: string }>) => unknown> = [];
  // shortcut: pending requests and live sockets belong to this process; lost on restart, harmless because runners reconnect and callers time out.
  /** Requests waiting for a runner's reply, by request id. */
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout; runnerId: string }>();
  /** Fails every request still waiting on this runner at once, so nothing waits for a reply that can't come (DR-014). */
  const failPending = (runnerId: string, reason: string) => {
    for (const [id, p] of [...pending]) {
      if (p.runnerId !== runnerId) continue;
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new RunnerGone(reason));
    }
  };
  // shortcut: live sockets belong to this process; lost on restart, harmless because runners reconnect.
  /** Live connections, so commands can reach a runner. */
  const connected = new Map<string, CommandSender>();
  // shortcut: per live socket; lost on restart, harmless because a runner sends its features again in hello.
  const features = new Map<string, string[]>();
  // shortcut: when each runner last connected; lost on a server restart, which only makes "settling" read false.
  const connectedAt = new Map<string, number>();
  // shortcut: when this server first saw each runner's current process after a restart (BOS-579). Lost on a server
  // restart: a hello after that compares the boot id with the stored one, so only a server restart in the few
  // minutes between a runner's restart and the lost-run sweep misses its stale runs.
  const restartedAt = new Map<string, number>();

  /** Marks a run ended and logs it. Runs inside the caller's transaction so a failed apply rolls the stored event back. */
  async function markEnded(tx: Tx, runId: string, at: Date, outcome: string | null, usage?: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedWriteTokens: number }) {
    // A run Boss Man stopped on purpose (the run time limit, BOS-846) says why. A real finish keeps the outcome
    // the runner reported (BOS-866): a run that finished in the gap before the runner confirmed the stop was not
    // cut off, so only a runner that really stopped it (outcome "cancelled", or none) takes the stored reason over.
    if (outcome === null || outcome === "cancelled") {
      const [r] = await tx.select({ stopReason: runs.stopReason }).from(runs).where(eq(runs.id, runId));
      if (r?.stopReason) outcome = `stopped: ${r.stopReason}`;
    }
    const [ended] = await tx
      .update(runs)
      .set({
        endedAt: at,
        outcome,
        ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedReadTokens: usage.cachedReadTokens, cachedWriteTokens: usage.cachedWriteTokens } : {}),
      })
      .where(eq(runs.id, runId))
      .returning({ fundingSourceId: runs.fundingSourceId, companyId: runs.companyId, agentId: runs.agentId, ticketId: runs.ticketId, purpose: runs.purpose, outcome: runs.outcome });
    // A run refused with "weekly limit" proves its account is full whatever the last reading said: mark it
    // full for an hour so new runs go to the next account instead of failing there again (BOS-463). A
    // real reading from the account replaces this as soon as one arrives.
    if (ended?.fundingSourceId && outcome && /weekly limit/i.test(outcome)) {
      await funding.recordQuota(ended.fundingSourceId, [{ provider: "anthropic", window: "seven_day", utilization: 1, resetsAt: new Date(at.getTime() + 60 * 60_000), status: "rejected", overageInUse: false }], at, tx);
    }
    // The run is over, so its token goes with it (BOS-513).
    // On `tx`, never the outer `db`: PGlite has one connection, so an outer-handle statement inside the
    // ingest transaction waits for it forever (BOS-623).
    await tx.delete(runTokens).where(eq(runTokens.runId, runId));
    // A finished run's own questions are moot: its permission requests leave the queue, and its
    // stall alert is closed by the one closer on `runActive`, which says why it went (DR-016, BOS-470).
    await tx
      .update(decisions)
      .set({
        status: "withdrawn",
        dedupeKey: null,
        context: sql`jsonb_set(${decisions.context}, '{withdrawn}', ${JSON.stringify({ by: "system", note: "The agent finished before this was answered, so there is nothing left to approve. No action needed.", at: at.toISOString() })}::jsonb, true)`,
      })
      .where(and(eq(decisions.status, "open"), eq(decisions.kind, "permission"), sql`${decisions.context}->>'runId' = ${runId}`));
    // Those cards are settled, so their notifications are read now rather than on the next feed poll (BOS-413).
    await tx
      .update(notifications)
      .set({ readAt: at })
      .where(and(isNull(notifications.readAt), sql`${notifications.decisionId} in (select ${decisions.id} from ${decisions} where coalesce(${decisions.context}->>'runId', '') = ${runId} and ${decisions.status} <> 'open')`));
    if (ended && ended.purpose !== "chat") await record(tx, { companyId: ended.companyId, agentId: ended.agentId, ticketId: ended.ticketId, kind: "run_ended", summary: `Run ended: ${ended.outcome ?? "ended"}`, at });
    return ended;
  }

  /** The first SQLSTATE five-character code found on the error or the errors it wraps, if any. */
  function sqlStateOf(err: unknown): string | null {
    for (let e = err as { code?: unknown; cause?: unknown } | null, i = 0; e && i < 3; e = e.cause as { code?: unknown; cause?: unknown } | null, i++) {
      if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    }
    return null;
  }

  /**
   * Whether an error came from the database failing to reach or answer us: Node system codes, or pg's
   * own connection and pool-timeout messages, which carry no code at all. These must always be retried
   * (BOS-584, BOS-606): losing a run.ended leaves a stuck run and losing a run.cost loses spend.
   */
  const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
  const TRANSIENT_MESSAGE = /^(?:timeout exceeded when trying to connect|connection terminated unexpectedly|connection terminated due to connection timeout|client has encountered a connection error and is not queryable|cannot use a pool after calling end on the pool|the database system is (?:starting up|shutting down))/i;
  function isTransientConnectionError(err: unknown): boolean {
    for (let e = err as { code?: unknown; message?: unknown; cause?: unknown } | null, i = 0; e && i < 3; e = e.cause as { code?: unknown; message?: unknown; cause?: unknown } | null, i++) {
      if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
      if (typeof e.message === "string" && TRANSIENT_MESSAGE.test(e.message.trim())) return true;
    }
    return false;
  }

  /** A thrown value that isn't an Error at all (a string, null) can't be debugged from a stack, so it is retried a few times then acks. */
  function isClearCodeError(err: unknown): boolean {
    return err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError;
  }

  /**
   * Whether a database problem is temporary: a connection failure, SQLSTATE 08xxx/40xxx, or any
   * other coded Postgres error. These always roll back and let the runner resend, and are never
   * counted toward the retry cap (BOS-584, BOS-606).
   */
  function isTransientApplyError(err: unknown): boolean {
    const code = sqlStateOf(err);
    if (code !== null) return !/^2[23]/.test(code);
    return isTransientConnectionError(err);
  }

  /** A clear code bug: it fails the same way on every resend, so it is kept, marked and acked at once. */
  function isPermanentApplyError(err: unknown): boolean {
    const code = sqlStateOf(err);
    return code !== null ? /^2[23]/.test(code) : isClearCodeError(err);
  }

  /**
   * Counts one more try at applying this seq and returns the new count, in its own committed
   * transaction so a rolled-back ingest can't lose it (BOS-606).
   */
  async function bumpAttempt(runnerId: string, seq: number): Promise<number> {
    const [row] = await db
      .insert(runnerEventAttempts)
      .values({ runnerId, seq, tries: 1 })
      .onConflictDoUpdate({ target: [runnerEventAttempts.runnerId, runnerEventAttempts.seq], set: { tries: sql`${runnerEventAttempts.tries} + 1` } })
      .returning({ tries: runnerEventAttempts.tries });
    return row?.tries ?? 1;
  }

  /** Forgets a seq's tries once it has landed (applied or skipped for good). */
  async function clearAttempts(runnerId: string, seq: number): Promise<void> {
    await db.delete(runnerEventAttempts).where(and(eq(runnerEventAttempts.runnerId, runnerId), eq(runnerEventAttempts.seq, seq)));
  }

  /**
   * A short, safe description of a failed apply for the activity log (BOS-605): only the SQLSTATE
   * code and the constraint name, never the SQL or its parameter values, which can carry another
   * company's data. Walked through drizzle's wrapped cause, like isPermanentApplyError. Kept to
   * about 200 characters.
   */
  function safeApplyError(err: unknown): string {
    let code: string | undefined;
    let constraint: string | undefined;
    for (let e = err as { code?: unknown; constraint?: unknown; cause?: unknown } | null, i = 0; e && i < 3; e = e.cause as { code?: unknown; constraint?: unknown; cause?: unknown } | null, i++) {
      if (code === undefined && typeof e.code === "string") code = e.code;
      if (constraint === undefined && typeof e.constraint === "string") constraint = e.constraint;
    }
    const parts = [code ? `code ${code}` : null, constraint ? `constraint ${constraint}` : null].filter(Boolean);
    const text = redact(parts.length ? parts.join(", ") : "error of unknown type").replace(/\s+/g, " ").trim();
    return text.slice(0, 200);
  }

  /**
   * The run.update payload as it is stored in runner_events (BOS-1368 security review): the Thinking
   * trace's short input, output and reasoning are redacted here too, so a raw secret can never sit in
   * that table even for a run whose trace is never read, and even from a runner image that predates
   * the runner-side redaction. Every other field is left exactly as the runner sent it.
   */
  function storedEvent(event: RunnerEvent): RunnerEvent {
    if (event.type !== "run.update") return event;
    const u = event.update as Record<string, unknown>;
    if (!u) return event;
    const redacted: Record<string, unknown> = { ...u };
    let changed = false;
    for (const k of ["inputSummary", "resultSummary", "text", "title"] as const) {
      const v = redacted[k];
      if (typeof v === "string") {
        const r = redact(v);
        if (r !== v) {
          redacted[k] = r;
          changed = true;
        }
      }
    }
    return changed ? ({ ...event, update: redacted } as RunnerEvent) : event;
  }

  /**
   * Applies one newly stored event inside `tx`, so the event insert and its effects commit together
   * and a transient failure rolls the insert back for the runner's resend (BOS-584). Returns the work
   * that must run after the commit because it talks to the outside world (the permission hook may send
   * a verdict over the socket and wake the CEO); it uses its own handle and is safe to repeat.
   */
  async function apply(tx: Tx, runner: Runner, event: RunnerEvent, at: Date): Promise<Array<() => Promise<unknown>>> {
    // Any word from a run counts as a sign of life for stall detection (R32).
    if ("runId" in event && event.type !== "run.started") {
      await tx.update(runs).set({ lastEventAt: sql`greatest(${runs.lastEventAt}, ${at.toISOString()}::timestamptz)` }).where(eq(runs.id, event.runId));
    }
    switch (event.type) {
      case "run.started":
        await tx
          .insert(runs)
          .values({ id: event.runId, companyId: runner.companyId, agentId: event.agentId, acpSessionId: event.acpSessionId, model: event.model, startedAt: at, lastEventAt: at })
          // The scheduler creates the run row at launch; the runner fills in the session.
          .onConflictDoUpdate({ target: runs.id, set: { acpSessionId: event.acpSessionId, model: event.model, lastEventAt: at } });
        return [];
      case "run.ended":
        await markEnded(tx, event.runId, at, event.interrupted ? "interrupted" : event.error ? `error: ${event.error}` : event.stopReason, event.usage);
        return [];
      case "run.cost": {
        if (event.costMicrosDelta === 0) return [];
        const [run] = await tx.select().from(runs).where(eq(runs.id, event.runId));
        // Infinite mode (BOS-279) doesn't spend the plan's credits, so its runs add nothing to any usage or budget
        // reading. The adapter's figure for a free model is a list-price guess, not money spent.
        if (isInfiniteModel(run?.model) || isInfiniteModel(event.model)) return [];
        const [eng] = run?.engagementId ? await tx.select().from(engagements).where(eq(engagements.id, run.engagementId)) : [];
        // The project the run worked on (BOS-1564), so a project spending limit counts it.
        const ticketId = run?.ticketId ?? run?.runTicketId;
        const [ticketRow] = ticketId ? await tx.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId)) : [];
        const base = {
          fundingSourceId: event.fundingSourceId,
          companyId: runner.companyId,
          projectId: ticketRow?.projectId ?? null,
          runId: event.runId,
          agentId: run?.agentId ?? null,
          engagementId: run?.engagementId ?? null,
          model: event.model,
          basis: "list_estimate" as const,
          occurredAt: at,
        };
        if (!eng) {
          await funding.recordCost({ ...base, costMicros: event.costMicrosDelta }, tx);
          return [];
        }
        // Engagement work is charged to the requester (R26), up to the engagement's cap;
        // anything past the cap stays with the provider.
        let charged = event.costMicrosDelta;
        if (eng.budgetCapMicros != null) {
          const [sum] = await tx
            .select({ total: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
            .from(costEvents)
            .where(and(eq(costEvents.engagementId, eng.id), isNotNull(costEvents.chargedCompanyId)));
          const left = Math.max(0, eng.budgetCapMicros - Number(sum?.total ?? 0));
          charged = Math.min(event.costMicrosDelta, left);
          if (charged < event.costMicrosDelta) {
            await tx
              .insert(decisions)
              .values({
                companyId: eng.requesterCompanyId,
                kind: "budget",
                question: `"${eng.title}" has used its $${(eng.budgetCapMicros / 1e6).toFixed(2)} cost cap. Further work on it is charged to the providing company.`,
                options: ["Got it"],
                recommendedOption: "Got it",
                dedupeKey: `engagement-cap:${eng.id}`,
                context: { type: "question" },
              })
              .onConflictDoNothing();
          }
        }
        if (charged > 0) await funding.recordCost({ ...base, costMicros: charged, chargedCompanyId: eng.requesterCompanyId, chargedProjectId: eng.requesterProjectId }, tx);
        if (event.costMicrosDelta - charged > 0) await funding.recordCost({ ...base, costMicros: event.costMicrosDelta - charged }, tx);
        return [];
      }
      case "run.workspace":
        await tx.update(tickets).set({ branch: event.branch, baseCommit: event.baseCommit }).where(eq(tickets.id, event.ticketId));
        return [];
      case "run.quota":
        await funding.recordQuotaFromAdapter(event.fundingSourceId, event, tx);
        return [];
      case "run.permission_request":
        // Kept out of the transaction: it may send a verdict over the socket and wake the CEO. Its
        // rows are dedupe-keyed by request id, so re-running it on the resend is harmless.
        return [async () => (await onPermission?.(runner, event)) ?? null];
      case "runner.log":
        // A failed tool-connection preflight is worth a line in the server log (BOS-403). Logged
        // after commit, so a resent (already stored) event doesn't log twice.
        if (event.message.startsWith("mcp-preflight:")) {
          const line = `[runner ${runner.id}] ${event.message}`;
          return [async () => console.warn(line)];
        }
        return [];
      default:
        // run.update and runner.log are stored; later phases act on them.
        return [];
    }
  }

  return {
    /** Creates (or replaces) a company's runner and returns its token, which is shown once. */
    async register(companyId: string): Promise<{ runnerId: string; token: string }> {
      const token = `bmr_${randomBytes(32).toString("base64url")}`;
      const [row] = await db
        .insert(runners)
        .values({ companyId, tokenHash: hashToken(token) })
        .onConflictDoUpdate({ target: runners.companyId, set: { tokenHash: hashToken(token) } })
        .returning();
      return { runnerId: row!.id, token };
    },

    async authenticate(token: string | undefined): Promise<Runner | null> {
      if (!token) return null;
      const [row] = await db.select().from(runners).where(eq(runners.tokenHash, hashToken(token)));
      return row ?? null;
    },

    async lastSeq(runnerId: string): Promise<number> {
      const [row] = await db.select({ m: max(runnerEvents.seq) }).from(runnerEvents).where(eq(runnerEvents.runnerId, runnerId));
      return row?.m ?? 0;
    },

    /** Stores the entry once; effects run only the first time it arrives. Returns false for a duplicate. */
    async ingest(runner: Runner, entry: JournalEntry): Promise<boolean> {
      const at = new Date(entry.at);
      // The event and everything it changes are one transaction (BOS-584): if applying throws, the
      // insert rolls back too, so the runner's resend is a new event and gets applied, not skipped.
      // A data or constraint error (SQLSTATE 22/23) is the exception: it repeats on every resend, and
      // retrying it would stall every later event for this company (acks are cumulative). Then the
      // effect is rolled back and the event is kept, marked and logged, so the stream moves on.
      // An unexplained error is retried MAX_APPLY_ATTEMPTS times before that (BOS-606), so a database
      // blip is never dropped, while a payload bug still can't hold the stream for ever.
      // Tries are counted only when applying fails, in a small transaction of their own that commits
      // on its own. A failed ingest rolls back the whole event transaction, so the count can't live
      // on the event row: a rollback there would take it too, and an event that never applies would
      // be retried for ever. Counting only on failure also means the normal path costs no extra write
      // and a resent event that has already landed leaves nothing behind (BOS-606).
      try {
        const { inserted, afterCommit } = await db.transaction(async (tx) => {
          const rows = await tx
            .insert(runnerEvents)
            .values({ runnerId: runner.id, seq: entry.seq, type: entry.event.type, payload: storedEvent(entry.event), occurredAt: at })
            .onConflictDoNothing()
            .returning({ id: runnerEvents.id });
          if (rows.length === 0) return { inserted: false, afterCommit: [] as Array<() => Promise<unknown>> };
          // The savepoint separates applying from storing, so a data error can undo only the effects
          // while the event row stays and the stream moves on.
          const work = await tx.transaction((sp) => apply(sp, runner, entry.event, at));
          return { inserted: true, afterCommit: work };
        });
        // Landed (applied): the event and its effects are committed, so any tries are history.
        if (inserted) await clearAttempts(runner.id, entry.seq);
        if (inserted) {
          // Only outward-facing work (the permission hook) runs after the commit, and it is repeatable.
          for (const step of afterCommit) await step();
          for (const h of syncHooks) await h(runner, entry.event);
          for (const l of listeners) l(runner, entry.event);
        }
        return inserted;
      } catch (err) {
        // A temporary database problem: roll back and let the runner resend. It is never counted
        // toward the cap, so an outage can't burn an event's tries.
        if (isTransientApplyError(err)) throw err;
        // A clear code bug is permanent on the first try. Any other unexplained error might be a
        // payload bug, so it is retried up to MAX_APPLY_ATTEMPTS before being kept and acked. The
        // count is bumped outside the (now rolled-back) event transaction, on its own connection.
        const permanent = isPermanentApplyError(err);
        const tried = permanent ? 1 : await bumpAttempt(runner.id, entry.seq);
        if (!permanent && tried < MAX_APPLY_ATTEMPTS) throw err;
        const skipped = safeApplyError(err);
        // Keep the event without its effects, mark it and ack it so the stream moves on: the insert
        // and the activity row commit together, and the tries are cleared once it has landed.
        await db.transaction(async (tx) => {
          await tx
            .insert(runnerEvents)
            .values({ runnerId: runner.id, seq: entry.seq, type: entry.event.type, payload: storedEvent(entry.event), occurredAt: at })
            .onConflictDoNothing();
          await record(tx, {
            companyId: runner.companyId,
            kind: "runner_event_failed",
            summary: `Runner event ${entry.seq} (${entry.event.type}) could not be applied and was skipped: ${skipped}`,
            detail: { seq: entry.seq, type: entry.event.type, error: skipped, attempts: tried },
            at,
          });
        });
        await clearAttempts(runner.id, entry.seq);
        return true;
      }
    },

    /**
     * Ends a run from this side when the runner can't (offline, lost, or didn't confirm a
     * cancel): the same marking and listeners as the runner's own run.ended. No-op if already ended.
     * `interrupted` says the run was cut off, not stopped by anyone (a runner that went offline and
     * never reported it): listeners treat it as the runner's own interrupted end and resume it (BOS-574).
     */
    async endRun(runId: string, outcome: string, at: Date = new Date(), how: { interrupted?: boolean } = {}): Promise<boolean> {
      const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), isNull(runs.endedAt)));
      if (!run) return false;
      await db.transaction(async (tx) => {
        await markEnded(tx, runId, at, outcome);
      });
      const [runner] = await db.select().from(runners).where(eq(runners.companyId, run.companyId));
      const endedRunner = runner ?? ({ companyId: run.companyId } as Runner);
      const event = { type: "run.ended" as const, runId, stopReason: null, error: null, ...(how.interrupted ? { interrupted: true } : {}) };
      // The sync hooks close what the end settles (BOS-217); listeners only read the event and the company.
      for (const h of syncHooks) await h(endedRunner, event);
      for (const l of listeners) l(endedRunner, event);
      return true;
    },

    /** Keeps the runner's latest fence self-test (BOS-321). */
    async recordSandbox(runnerId: string, report: SandboxReport, at: Date) {
      await db.update(runners).set({ sandbox: report, sandboxCheckedAt: at }).where(eq(runners.id, runnerId));
    },

    /** Called after the server closes a run the runner doesn't have, so it can be resumed (BOS-583). */
    onLost(listener: (runId: string) => unknown) {
      lostListeners.push(listener);
    },

    /** Test hook: how long after hello the runner's run list is acted on. */
    setLiveRunsDelay(ms: number) {
      liveRunsDelayMs = ms;
    },

    /**
     * Closes this runner's open runs that its hello list leaves out, as "lost: runner doesn't have it",
     * and hands each to the lost listeners to resume (BOS-583). Runs started within the grace period
     * are left alone, measured back from the hello (helloAt), not from when this check runs: a run
     * started just before the hello may not have reached the runner yet. Returns the ids closed.
     * A runner that sent no list never gets here.
     */
    async reconcileLive(runner: Runner, liveRunIds: string[], at: Date = new Date(), helloAt: Date = at): Promise<string[]> {
      const open = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.companyId, runner.companyId), isNull(runs.endedAt), lt(runs.startedAt, new Date(helloAt.getTime() - LIVE_RUNS_GRACE_MS))));
      const live = new Set(liveRunIds);
      const closed: string[] = [];
      for (const { id: runId } of open) {
        if (live.has(runId)) continue;
        if (!(await this.endRun(runId, "lost: runner doesn't have it", at))) continue;
        closed.push(runId);
        for (const l of lostListeners) await Promise.resolve(l(runId)).catch(() => {});
      }
      return closed;
    },

    /** Waits for the runner to replay anything it finished offline, then reconciles, if it is still connected. */
    reconcileLater(runner: Runner, liveRunIds: string[]) {
      const helloAt = new Date();
      const timer = setTimeout(() => {
        if (!connected.has(runner.id)) return;
        void this.reconcileLive(runner, liveRunIds, new Date(), helloAt).catch(() => {});
      }, liveRunsDelayMs);
      timer.unref();
    },

    async touch(runner: Runner, imageVersion: string | null, harnessVersions?: Record<string, string>, imageCommit?: string) {
      // An older runner sends none: keep what we last knew rather than blanking it. A new image with no
      // commit (built outside a checkout) clears the old one, so a stale commit never vouches for it (BOS-764).
      const [before] = await db.select({ commit: runners.imageCommit }).from(runners).where(eq(runners.id, runner.id));
      const next = imageCommit?.toLowerCase() ?? null;
      await db.update(runners).set({ lastSeenAt: new Date(), imageVersion, imageCommit: next, ...(harnessVersions ? { harnessVersions } : {}) }).where(eq(runners.id, runner.id));
      // BOS-1161: a hello that brings a different image commit is a finished rebuild; the caller flags the cards it makes moot.
      return { imageChanged: !!next && next !== (before?.commit ?? null) };
    },

    /**
     * A runner said hello with its boot id (BOS-352). A new id means the process restarted, which
     * silently kills any background check an agent started. The checks parked on a schedule_check
     * keep their booked time (BOS-1075): pulling them forward here fired every pending check on
     * every restart, so a deploy check booked for later went off seven times in a day. Mark them
     * instead, so the wake at its own time still says the runner restarted; runs cut off are
     * resumed by the recovery sweep. A reconnect (same id) changes nothing.
     */
    async bootSeen(runner: Runner, bootId: string | undefined, hello: Omit<HelloRestart, "bootId"> = {}): Promise<number> {
      if (!bootId || bootId === runner.bootId) return 0;
      failPending(runner.id, "The runner restarted while this was running.");
      const at = new Date();
      // A runner with no boot id on record (new, or older than BOS-352) can't be told apart from a reconnect.
      if (runner.bootId) restartedAt.set(runner.id, at.getTime());
      await db.update(runners).set({ bootId }).where(eq(runners.id, runner.id));
      // Why it restarted, for the feed and server_status (BOS-594). A failure here must not stop the marking below.
      try {
        const last = await recordRestart(db, runner, { bootId, ...hello }, { firstBoot: !runner.bootId, at });
        if (runner.bootId) for (const l of [...restartListeners]) void Promise.resolve(l(runner, last)).catch(() => {});
      } catch {
        /* the restart still happened; only its reason is lost */
      }
      const pending = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.companyId, runner.companyId), isNotNull(tickets.monitorAt), gt(tickets.monitorAt, at), isNotNull(tickets.assigneeAgentId)));
      if (!pending.length) return 0;
      await db.update(tickets).set({ monitorRestartAt: at }).where(inArray(tickets.id, pending.map((p) => p.id)));
      return pending.length;
    },

    connect(runnerId: string, send: CommandSender, feats: string[] = []) {
      connected.set(runnerId, send);
      connectedAt.set(runnerId, Date.now());
      features.set(runnerId, feats);
      for (const l of [...connectListeners]) void Promise.resolve(l(runnerId)).catch(() => {});
      return () => {
        if (connected.get(runnerId) === send) {
          connected.delete(runnerId);
          failPending(runnerId, "The runner disconnected while this was running.");
        }
      };
    },

    /** Whether the connected runner said it can do this (hello.features). */
    can: (runnerId: string, feature: (typeof RUNNER_FEATURES)[number]) => !!features.get(runnerId)?.includes(feature),

    send(runnerId: string, command: RunnerCommand): boolean {
      return connected.get(runnerId)?.(command) ?? false;
    },

    isConnected: (runnerId: string) => connected.has(runnerId),

    /**
     * Whether the runner (re)connected in the last few minutes, so it is probably mid-swap: runs
     * queued behind it are still being started and "never started" alerts can wait.
     */
    isSettling: (runnerId: string, at: Date = new Date()) => at.getTime() - (connectedAt.get(runnerId) ?? -Infinity) < RUNNER_SETTLE_MS,

    /**
     * When this server saw the runner's current process start, if it saw a restart (BOS-579). A run
     * that began before then was on the old process: the new one can't carry it on or report on it.
     */
    restartedAt: (runnerId: string) => (restartedAt.has(runnerId) ? new Date(restartedAt.get(runnerId)!) : null),

    connectedSince: (runnerId: string) => (connectedAt.has(runnerId) && connected.has(runnerId) ? new Date(connectedAt.get(runnerId)!) : null),

    /**
     * Resolves true once the runner is connected (at once if it already is), false after maxMs.
     * A runner swap takes minutes; callers wait here instead of using up their retries (DR-014).
     */
    waitConnected(runnerId: string, maxMs: number): Promise<boolean> {
      if (connected.has(runnerId)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          connectListeners.splice(connectListeners.indexOf(listener), 1);
          resolve(false);
        }, maxMs);
        const listener = (id: string) => {
          if (id !== runnerId) return;
          clearTimeout(timer);
          connectListeners.splice(connectListeners.indexOf(listener), 1);
          resolve(true);
        };
        connectListeners.push(listener);
      });
    },

    /** Sends a request command and waits for the runner's reply. */
    request<T>(runnerId: string, build: (requestId: string) => RunnerCommand, timeoutMs = 15_000): Promise<T> {
      const requestId = randomBytes(12).toString("base64url");
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("The runner didn't answer in time."));
        }, timeoutMs);
        pending.set(requestId, { resolve: resolve as (d: unknown) => void, reject, timer, runnerId });
        if (!connected.get(runnerId)?.(build(requestId))) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(new RunnerGone("The company's runner is offline."));
        }
      });
    },

    /**
     * Asks a runner how its add-ons are (docs/12) and keeps the answer. When it changes, the
     * "skill held back" notices for that runner are cleared, so a later breakage is told again.
     */
    async checkAddons(runnerId: string) {
      if (!this.isConnected(runnerId) || !this.can(runnerId, "addons")) return null;
      const report = z.array(AddonReport).max(50).parse(await this.request<unknown>(runnerId, (requestId) => ({ type: "addons.check", requestId }), 60_000));
      const [before] = await db.select({ addons: runners.addons }).from(runners).where(eq(runners.id, runnerId));
      if (JSON.stringify(before?.addons ?? null) === JSON.stringify(report)) return report;
      await db.update(runners).set({ addons: report }).where(eq(runners.id, runnerId));
      await db.delete(settings).where(like(settings.key, `addon-missing:${runnerId}:%`));
      return report;
    },

    /** Every connected runner's add-ons, for the background loop. */
    async checkAllAddons() {
      for (const runnerId of [...connected.keys()]) await this.checkAddons(runnerId).catch(() => null);
    },

    /** Delivers a runner's reply to whoever asked. */
    resolveReply(reply: { requestId: string; ok: boolean; data?: unknown; error?: string }) {
      const p = pending.get(reply.requestId);
      if (!p) return;
      pending.delete(reply.requestId);
      clearTimeout(p.timer);
      if (reply.ok) p.resolve(reply.data);
      else p.reject(new Error(reply.error ?? "The runner couldn't do that."));
    },

    setPermissionHook(hook: PermissionHook) {
      onPermission = hook;
    },

    /** Called whenever a runner (re)connects, e.g. to re-send verdicts it missed. */
    onConnect(listener: (runnerId: string) => unknown) {
      connectListeners.push(listener);
    },

    /** Called once per runner restart (a new boot id after a known one), with its recorded reason (BOS-594). */
    onRestart(listener: (runner: Runner, last: LastRestart) => unknown) {
      restartListeners.push(listener);
    },

    /** Called when a reconnecting runner lists the permission requests it's still waiting on. */
    onResume(listener: (runner: Runner, pending: Array<{ runId: string; requestId: string }>) => unknown) {
      resumeListeners.push(listener);
    },
    async resumed(runner: Runner, pending: Array<{ runId: string; requestId: string }>) {
      for (const l of resumeListeners) await l(runner, pending);
    },

    /** Called after each newly stored event's effects are applied. */
    onEvent(listener: (runner: Runner, event: RunnerEvent) => void) {
      listeners.push(listener);
    },

    /** Called and awaited after each newly stored event's effects are applied, before the event is acknowledged. */
    onEventSync(hook: (runner: Runner, event: RunnerEvent) => Promise<unknown>) {
      syncHooks.push(hook);
    },
  };
}
