import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * Deletes runner events older than `days`, a few thousand rows per statement so no transaction
 * runs long (BOS-416). Kept on purpose:
 *  - the newest event of each runner, because the runner's resume point (lastSeq) is read from it;
 *  - events of runs still going, so a long run's transcript and recovery never lose their start.
 * Nothing else reads old events: cost comes from cost_events and forensics read the session
 * transcript. Only the Runs page transcript reads them, and it says "No events are kept for this run" for an ended pruned run.
 * `stop` lets a demotion end the pass between batches.
 */
export async function pruneRunnerEvents(
  db: Db,
  opts: { days: number; batch?: number; now?: Date; stop?: () => boolean; maxBatches?: number },
): Promise<number> {
  const batch = opts.batch ?? 2000;
  const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.days * 86_400_000);
  let total = 0;
  for (let i = 0; i < (opts.maxBatches ?? 500); i++) {
    if (opts.stop?.()) break;
    const res = await db.execute(sql`
      delete from runner_events where id in (
        select e.id from runner_events e
        where e.occurred_at < ${cutoff.toISOString()}::timestamptz
          and exists (select 1 from runner_events n where n.runner_id = e.runner_id and n.seq > e.seq)
          and not exists (select 1 from runs r where r.ended_at is null and r.id::text = e.payload->>'runId')
        limit ${batch}
      ) returning id`);
    const n = (res as { rows?: unknown[] }).rows?.length ?? (Array.isArray(res) ? res.length : 0);
    total += n;
    if (n < batch) break;
  }
  return total;
}

/** BOSSMAN_RUNNER_EVENTS_DAYS: days to keep (default 60); 0 or junk falls back to the default. */
export function runnerEventsDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 60;
}
