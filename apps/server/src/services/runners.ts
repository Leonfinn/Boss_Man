// Runner registration, authentication and event ingestion (R31).
import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, max, sql } from "drizzle-orm";
import type { JournalEntry, RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { hashToken } from "../auth.js";
import type { Db } from "../db/client.js";
import { costEvents, decisions, engagements, runnerEvents, runners, runs, tickets } from "../db/schema.js";
import type { fundingService } from "./funding.js";

type Runner = typeof runners.$inferSelect;
export type CommandSender = (command: RunnerCommand) => boolean;

export type PermissionHook = (runner: Runner, event: Extract<RunnerEvent, { type: "run.permission_request" }>) => Promise<unknown>;

export function runnersService(db: Db, funding: ReturnType<typeof fundingService>) {
  let onPermission: PermissionHook | null = null;
  const listeners: Array<(runner: Runner, event: RunnerEvent) => void> = [];
  const connectListeners: Array<(runnerId: string) => unknown> = [];
  /** Requests waiting for a runner's reply, by request id. */
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  /** Live connections, so commands can reach a runner. */
  const connected = new Map<string, CommandSender>();

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
        await db
          .update(runs)
          .set({ endedAt: at, outcome: event.interrupted ? "interrupted" : event.error ? `error: ${event.error}` : event.stopReason })
          .where(eq(runs.id, event.runId));
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

    async touch(runner: Runner, imageVersion: string | null) {
      await db.update(runners).set({ lastSeenAt: new Date(), imageVersion }).where(eq(runners.id, runner.id));
    },

    connect(runnerId: string, send: CommandSender) {
      connected.set(runnerId, send);
      for (const l of connectListeners) void Promise.resolve(l(runnerId)).catch(() => {});
      return () => {
        if (connected.get(runnerId) === send) connected.delete(runnerId);
      };
    },

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

    /** Called after each newly stored event's effects are applied. */
    onEvent(listener: (runner: Runner, event: RunnerEvent) => void) {
      listeners.push(listener);
    },
  };
}
