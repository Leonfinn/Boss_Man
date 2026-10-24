// Runner registration, authentication and event ingestion (R31).
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, like, max, sql } from "drizzle-orm";
import { z } from "zod";
import { AddonReport, type JournalEntry, type RUNNER_FEATURES, type RunnerCommand, type RunnerEvent } from "@boss-man/shared";
import { hashToken } from "../auth.js";
import type { Db } from "../db/client.js";
import { record } from "./activity.js";
import { costEvents, decisions, engagements, runnerEvents, runners, runs, settings, tickets } from "../db/schema.js";
import type { fundingService } from "./funding.js";

type Runner = typeof runners.$inferSelect;
export type CommandSender = (command: RunnerCommand) => boolean;

export type PermissionHook = (runner: Runner, event: Extract<RunnerEvent, { type: "run.permission_request" }>) => Promise<unknown>;

export function runnersService(db: Db, funding: ReturnType<typeof fundingService>) {
  let onPermission: PermissionHook | null = null;
  const listeners: Array<(runner: Runner, event: RunnerEvent) => void> = [];
  const connectListeners: Array<(runnerId: string) => unknown> = [];
  const resumeListeners: Array<(runner: Runner, pending: Array<{ runId: string; requestId: string }>) => unknown> = [];
  // shortcut: pending requests and live sockets belong to this process; lost on restart, harmless because runners reconnect and callers time out.
  /** Requests waiting for a runner's reply, by request id. */
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  // shortcut: live sockets belong to this process; lost on restart, harmless because runners reconnect.
  /** Live connections, so commands can reach a runner. */
  const connected = new Map<string, CommandSender>();
  // shortcut: per live socket; lost on restart, harmless because a runner sends its features again in hello.
  const features = new Map<string, string[]>();

  /** Marks a run ended and logs it. */
  async function markEnded(runId: string, at: Date, outcome: string | null, usage?: { inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedWriteTokens: number }) {
    const [ended] = await db
      .update(runs)
      .set({
        endedAt: at,
        outcome,
        ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedReadTokens: usage.cachedReadTokens, cachedWriteTokens: usage.cachedWriteTokens } : {}),
      })
      .where(eq(runs.id, runId))
      .returning({ companyId: runs.companyId, agentId: runs.agentId, ticketId: runs.ticketId, purpose: runs.purpose, outcome: runs.outcome });
    // A finished run's own questions are moot: its permission requests and stall alerts leave the queue.
    await db
      .update(decisions)
      .set({ status: "withdrawn", dedupeKey: null })
      .where(and(eq(decisions.status, "open"), inArray(decisions.kind, ["permission", "stalled_run"]), sql`${decisions.context}->>'runId' = ${runId}`));
    if (ended && ended.purpose !== "chat") await record(db, { companyId: ended.companyId, agentId: ended.agentId, ticketId: ended.ticketId, kind: "run_ended", summary: `Run ended: ${ended.outcome ?? "ended"}`, at });
    return ended;
  }

  async function apply(runner: Runner, event: RunnerEvent, at: Date) {
    // Any word from a run counts as a sign of life for stall detection (R32).
    if ("runId" in event && event.type !== "run.started") {
      await db.update(runs).set({ lastEventAt: sql`greatest(${runs.lastEventAt}, ${at.toISOString()}::timestamptz)` }).where(eq(runs.id, event.runId));
    }
    switch (event.type) {
      case "run.started":
        await db
          .insert(runs)
          .values({ id: event.runId, companyId: runner.companyId, agentId: event.agentId, acpSessionId: event.acpSessionId, model: event.model, startedAt: at, lastEventAt: at })
          // The scheduler creates the run row at launch; the runner fills in the session.
          .onConflictDoUpdate({ target: runs.id, set: { acpSessionId: event.acpSessionId, model: event.model, lastEventAt: at } });
        return;
      case "run.ended":
        await markEnded(event.runId, at, event.interrupted ? "interrupted" : event.error ? `error: ${event.error}` : event.stopReason, event.usage);
        return;
      case "run.cost": {
        if (event.costMicrosDelta === 0) return;
        const [run] = await db.select().from(runs).where(eq(runs.id, event.runId));
        const [eng] = run?.engagementId ? await db.select().from(engagements).where(eq(engagements.id, run.engagementId)) : [];
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
          await funding.recordCost({ ...base, costMicros: event.costMicrosDelta });
          return;
        }
        // Engagement work is charged to the requester (R26), up to the engagement's cap;
        // anything past the cap stays with the provider.
        let charged = event.costMicrosDelta;
        if (eng.budgetCapMicros != null) {
          const [sum] = await db
            .select({ total: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
            .from(costEvents)
            .where(and(eq(costEvents.engagementId, eng.id), isNotNull(costEvents.chargedCompanyId)));
          const left = Math.max(0, eng.budgetCapMicros - Number(sum?.total ?? 0));
          charged = Math.min(event.costMicrosDelta, left);
          if (charged < event.costMicrosDelta) {
            await db
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
        if (charged > 0) await funding.recordCost({ ...base, costMicros: charged, chargedCompanyId: eng.requesterCompanyId, chargedProjectId: eng.requesterProjectId });
        if (event.costMicrosDelta - charged > 0) await funding.recordCost({ ...base, costMicros: event.costMicrosDelta - charged });
        return;
      }
      case "run.workspace":
        await db.update(tickets).set({ branch: event.branch, baseCommit: event.baseCommit }).where(eq(tickets.id, event.ticketId));
        return;
      case "run.quota":
        await funding.recordQuotaFromAdapter(event.fundingSourceId, event);
        return;
      case "run.permission_request":
        await onPermission?.(runner, event);
        return;
      default:
        // run.update and runner.log are stored; later phases act on them.
        return;
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
      const inserted = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(runnerEvents)
          .values({ runnerId: runner.id, seq: entry.seq, type: entry.event.type, payload: entry.event, occurredAt: at })
          .onConflictDoNothing()
          .returning({ id: runnerEvents.id });
        return rows.length > 0;
      });
      if (inserted) {
        await apply(runner, entry.event, at);
        for (const l of listeners) l(runner, entry.event);
      }
      return inserted;
    },

    /**
     * Ends a run from this side when the runner can't (offline, lost, or didn't confirm a
     * cancel): the same marking and listeners as the runner's own run.ended. No-op if already ended.
     */
    async endRun(runId: string, outcome: string, at: Date = new Date()): Promise<boolean> {
      const [run] = await db.select().from(runs).where(and(eq(runs.id, runId), isNull(runs.endedAt)));
      if (!run) return false;
      await markEnded(runId, at, outcome);
      const [runner] = await db.select().from(runners).where(eq(runners.companyId, run.companyId));
      // Listeners only read the event, and the runner's company; a company with no runner row still gets the handling.
      for (const l of listeners) l(runner ?? ({ companyId: run.companyId } as Runner), { type: "run.ended", runId, stopReason: null, error: null });
      return true;
    },

    async touch(runner: Runner, imageVersion: string | null) {
      await db.update(runners).set({ lastSeenAt: new Date(), imageVersion }).where(eq(runners.id, runner.id));
    },

    connect(runnerId: string, send: CommandSender, feats: string[] = []) {
      connected.set(runnerId, send);
      features.set(runnerId, feats);
      for (const l of connectListeners) void Promise.resolve(l(runnerId)).catch(() => {});
      return () => {
        if (connected.get(runnerId) === send) connected.delete(runnerId);
      };
    },

    /** Whether the connected runner said it can do this (hello.features). */
    can: (runnerId: string, feature: (typeof RUNNER_FEATURES)[number]) => !!features.get(runnerId)?.includes(feature),

    send(runnerId: string, command: RunnerCommand): boolean {
      return connected.get(runnerId)?.(command) ?? false;
    },

    isConnected: (runnerId: string) => connected.has(runnerId),

    /** Sends a request command and waits for the runner's reply. */
    request<T>(runnerId: string, build: (requestId: string) => RunnerCommand, timeoutMs = 15_000): Promise<T> {
      const requestId = randomBytes(12).toString("base64url");
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("The runner didn't answer in time."));
        }, timeoutMs);
        pending.set(requestId, { resolve: resolve as (d: unknown) => void, reject, timer });
        if (!connected.get(runnerId)?.(build(requestId))) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(new Error("The company's runner is offline."));
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
  };
}
