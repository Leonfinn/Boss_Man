// "A run ends itself after a time limit the owner sets" (BOS-846). Every other budget, cap and guard is
// checked when a run is about to start; this is the one that ends a run already going. Off by default:
// a company with no companies.max_run_minutes is never touched.
//
// Each sweep (about once a minute) finds the company's live runs that have gone past the limit and stops
// them through the same cancel as the Stop button (runs.ts cancel), with a reason that becomes the run's
// outcome "stopped: run time limit (N min)". The owner gets one card per stopped run.
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, companies, runs, tickets } from "../db/schema.js";
import type { AlertInput } from "./alert-ladder.js";

export const RAISE_RUN_LIMIT = "Raise the limit";
export const LEAVE_RUN_LIMIT = "Leave it";

/** The text a stopped run carries as its reason; the outcome is "stopped: " plus this. */
export const runLimitReason = (minutes: number) => `run time limit (${minutes} min)`;

export function runTimeLimitSweep(db: Db, opts: { now: () => Date; cancel: (runId: string, reason: string) => Promise<unknown>; alert: (input: AlertInput) => Promise<{ id: string } | null> }) {
  return {
    async run(): Promise<{ stopped: number }> {
      const t = opts.now();
      const live = await db
        .select({ id: runs.id, companyId: runs.companyId, startedAt: runs.startedAt, limit: companies.maxRunMinutes, agentName: agents.name, agentId: runs.agentId, ticketId: runs.ticketId, ticketTitle: tickets.title })
        .from(runs)
        .innerJoin(companies, eq(companies.id, runs.companyId))
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .leftJoin(tickets, eq(tickets.id, runs.ticketId))
        // The owner's chat is a conversation, not a work run; a run already told to stop is left to finish stopping.
        .where(and(isNull(runs.endedAt), isNull(runs.cancelRequestedAt), isNotNull(companies.maxRunMinutes), sql`${runs.purpose} is distinct from 'chat'`));
      let stopped = 0;
      for (const r of live) {
        const limit = r.limit!;
        const ranMs = t.getTime() - r.startedAt.getTime();
        if (ranMs < limit * 60_000) continue;
        try {
          await opts.cancel(r.id, runLimitReason(limit));
        } catch {
          continue; // already ended or not found: the next pass looks again
        }
        stopped++;
        const who = r.agentName ?? "An agent";
        await opts
          .alert({
            companyId: r.companyId,
            kind: "run_time_limit",
            question: `${who}'s run${r.ticketTitle ? ` on "${r.ticketTitle}"` : " (no ticket)"} was stopped after ${Math.round(ranMs / 60_000)} minutes, over the ${limit}-minute limit you set for a single run. Raise the limit (by half, to ${Math.ceil(limit * 1.5)} minutes), or leave it as it is?`,
            from: "owner",
            why: "the run time limit is the owner's setting",
            options: [RAISE_RUN_LIMIT, LEAVE_RUN_LIMIT],
            recommended: LEAVE_RUN_LIMIT,
            about: [r.agentId],
            dedupeKey: `run-time-limit:${r.id}`,
            clearWhen: [],
            context: { type: "run_time_limit", companyId: r.companyId, runId: r.id, minutes: limit },
          })
          .catch(() => null);
      }
      return { stopped };
    },
  };
}
