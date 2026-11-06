// Runner registration, authentication and event ingestion (R31).
import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, like, max, sql } from "drizzle-orm";
import { z } from "zod";
import { AddonReport, type JournalEntry, type RUNNER_FEATURES, type RunnerCommand, type RunnerEvent, type SandboxReport } from "@boss-man/shared";
import { hashToken } from "../auth.js";
import type { Db } from "../db/client.js";
import { record } from "./activity.js";
import { costEvents, decisions, engagements, notifications, runnerEvents, runners, runs, runTokens, settings, tickets } from "../db/schema.js";
import type { fundingService } from "./funding.js";

/** After a runner restart, at most this many parked checks are pulled forward, and none again within this long of the last restart (BOS-352). */
const RESTART_PULL_MAX = 20;
const RESTART_PULL_COOLDOWN_MS = 10 * 60_000;

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

  /** Marks a run ended and logs it. Runs inside the caller's transaction so a failed apply rolls the stored event back. */
  async function markEnded(tx: Tx, runId: string, at: Date, outcome: string | null, usage?: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedWriteTokens: number }) {
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
    await db.delete(runTokens).where(eq(runTokens.runId, runId));
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

  /**
   * Whether an error is a data or constraint error (SQLSTATE class 22 or 23), which the same event
   * will hit on every resend: the payload or the row it points at is wrong, not the connection. Those
   * must not be retried for ever (BOS-584), unlike a dropped connection or a serialization failure.
   */
  function isPermanentApplyError(err: unknown): boolean {
    for (let e = err as { code?: unknown; cause?: unknown } | null, i = 0; e && i < 3; e = e.cause as { code?: unknown; cause?: unknown } | null, i++) {
      if (typeof e.code === "string" && /^2[23]/.test(e.code)) return true;
    }
    return false;
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
        const [eng] = run?.engagementId ? await tx.select().from(engagements).where(eq(engagements.id, run.engagementId)) : [];
        const base = {
          fundingSourceId: event.fundingSourceId,
          companyId: runner.companyId,
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
      // A data or constraint error is the exception: it repeats on every resend, and retrying it
      // would stall every later event for this company (acks are cumulative). Then the effect is
      // rolled back and the event is kept, marked and logged, so the stream moves on.
      let skipped: string | null = null;
      const { inserted, afterCommit } = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(runnerEvents)
          .values({ runnerId: runner.id, seq: entry.seq, type: entry.event.type, payload: entry.event, occurredAt: at })
          .onConflictDoNothing()
          .returning({ id: runnerEvents.id });
        if (rows.length === 0) return { inserted: false, afterCommit: [] as Array<() => Promise<unknown>> };
        // The savepoint separates applying from storing, so a data error can undo only the effects
        // while the event row stays and the stream moves on.
        try {
          const work = await tx.transaction((sp) => apply(sp, runner, entry.event, at));
          return { inserted: true, afterCommit: work };
        } catch (err) {
          if (!isPermanentApplyError(err)) throw err;
          skipped = (err as Error).message;
          await record(tx, {
            companyId: runner.companyId,
            kind: "runner_event_failed",
            summary: `Runner event ${entry.seq} (${entry.event.type}) could not be applied and was skipped: ${skipped}`,
            detail: { seq: entry.seq, type: entry.event.type, error: skipped },
            at,
          });
          return { inserted: true, afterCommit: [] as Array<() => Promise<unknown>> };
        }
      });
      if (inserted) {
        // Only outward-facing work (the permission hook) runs after the commit, and it is repeatable.
        for (const step of afterCommit) await step();
        for (const h of syncHooks) await h(runner, entry.event);
        for (const l of listeners) l(runner, entry.event);
      }
      return inserted;
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

    async touch(runner: Runner, imageVersion: string | null, harnessVersions?: Record<string, string>) {
      // An older runner sends none: keep what we last knew rather than blanking it.
      await db.update(runners).set({ lastSeenAt: new Date(), imageVersion, ...(harnessVersions ? { harnessVersions } : {}) }).where(eq(runners.id, runner.id));
    },

    /**
     * A runner said hello with its boot id (BOS-352). A new id means the process restarted, which
     * silently kills any background check an agent started, so the checks parked on a schedule_check
     * are pulled forward to now, each with a note. Capped, and skipped when a restart pulled some
     * minutes ago, so a restart loop can't flood wakes. A reconnect (same id) changes nothing.
     */
    async bootSeen(runner: Runner, bootId: string | undefined): Promise<number> {
      if (!bootId || bootId === runner.bootId) return 0;
      failPending(runner.id, "The runner restarted while this was running.");
      const at = new Date();
      await db.update(runners).set({ bootId }).where(eq(runners.id, runner.id));
      if (runner.bootPulledAt && at.getTime() - runner.bootPulledAt.getTime() < RESTART_PULL_COOLDOWN_MS) return 0;
      const pending = await db
        .select({ id: tickets.id, assigneeAgentId: tickets.assigneeAgentId })
        .from(tickets)
        .where(and(eq(tickets.companyId, runner.companyId), isNotNull(tickets.monitorAt), gt(tickets.monitorAt, at), isNotNull(tickets.assigneeAgentId)))
        .orderBy(asc(tickets.monitorAt))
        .limit(RESTART_PULL_MAX);
      if (!pending.length) return 0;
      await db.update(runners).set({ bootPulledAt: at }).where(eq(runners.id, runner.id));
      await db.update(tickets).set({ monitorAt: at, monitorRestartAt: at }).where(inArray(tickets.id, pending.map((p) => p.id)));
      for (const p of pending) await record(db, { companyId: runner.companyId, agentId: p.assigneeAgentId, ticketId: p.id, kind: "monitor", summary: "The runner restarted: the scheduled check was brought forward", at });
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
