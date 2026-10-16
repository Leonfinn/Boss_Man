// Runner registration, authentication and event ingestion (R31).
import { randomBytes } from "node:crypto";
import { eq, max } from "drizzle-orm";
import type { JournalEntry, RunnerCommand, RunnerEvent } from "@boss-man/shared";
import { hashToken } from "../auth.js";
import type { Db } from "../db/client.js";
import { engagements, runnerEvents, runners, runs } from "../db/schema.js";
import type { fundingService } from "./funding.js";

type Runner = typeof runners.$inferSelect;
export type CommandSender = (command: RunnerCommand) => boolean;

export type PermissionHook = (runner: Runner, event: Extract<RunnerEvent, { type: "run.permission_request" }>) => Promise<unknown>;

export function runnersService(db: Db, funding: ReturnType<typeof fundingService>) {
  let onPermission: PermissionHook | null = null;
  /** Live connections, so commands can reach a runner. */
  const connected = new Map<string, CommandSender>();

  async function apply(runner: Runner, event: RunnerEvent, at: Date) {
    switch (event.type) {
      case "run.started":
        await db
          .insert(runs)
          .values({ id: event.runId, companyId: runner.companyId, agentId: event.agentId, acpSessionId: event.acpSessionId, model: event.model, startedAt: at })
          .onConflictDoNothing();
        return;
      case "run.ended":
        await db.update(runs).set({ endedAt: at, outcome: event.error ? `error: ${event.error}` : event.stopReason }).where(eq(runs.id, event.runId));
        return;
      case "run.cost": {
        if (event.costMicrosDelta === 0) return;
        const [run] = await db.select().from(runs).where(eq(runs.id, event.runId));
        // Engagement work is charged to the requester (R26).
        const [eng] = run?.engagementId ? await db.select().from(engagements).where(eq(engagements.id, run.engagementId)) : [];
        await funding.recordCost({
          fundingSourceId: event.fundingSourceId,
          companyId: runner.companyId,
          runId: event.runId,
          agentId: run?.agentId ?? null,
          engagementId: run?.engagementId ?? null,
          chargedCompanyId: eng?.requesterCompanyId ?? null,
          chargedProjectId: eng?.requesterProjectId ?? null,
          model: event.model,
          costMicros: event.costMicrosDelta,
          basis: "list_estimate",
          occurredAt: at,
        });
        return;
      }
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
      if (inserted) await apply(runner, entry.event, at);
      return inserted;
    },

    async touch(runner: Runner, imageVersion: string | null) {
      await db.update(runners).set({ lastSeenAt: new Date(), imageVersion }).where(eq(runners.id, runner.id));
    },

    connect(runnerId: string, send: CommandSender) {
      connected.set(runnerId, send);
      return () => {
        if (connected.get(runnerId) === send) connected.delete(runnerId);
      };
    },

    send(runnerId: string, command: RunnerCommand): boolean {
      return connected.get(runnerId)?.(command) ?? false;
    },

    isConnected: (runnerId: string) => connected.has(runnerId),

    setPermissionHook(hook: PermissionHook) {
      onPermission = hook;
    },
  };
}
