// BOS-1438: a run the provider refuses for an account limit is a held wake, not a failed run.
// Its wake is put back in the queue, held until the account's real reset, so the work resumes by
// itself when the limit lifts. Once per (agent, ticket, limit window): a second refusal in the same
// window is the account card (BOS-1425), not another requeue. Auth errors are never requeued.
import { and, desc, eq, gt, like, sql } from "drizzle-orm";
import { cleanEndSql } from "./no-progress.js";
import type { Db } from "../db/client.js";
import { activity, agents, fundingSources, quotaSamples, runs, wakes } from "../db/schema.js";
import { accountOutage } from "./loop-guards.js";
import { record } from "./activity.js";

/** Wake hold reason for a limit-refused wake. Not matched by the scheduler's "nearly used up" quota-hold pattern, so the wake is skipped until its notBefore. */
export const LIMIT_HELD_PREFIX = "subscription limit hit:";
export const LIMIT_REQUEUE_KIND = "limit_requeue";
/** BOS-463 marks an account full for this long after a refusal; the made-up reading is told apart by its exact length. */
const MADE_UP_MS = 60 * 60_000;
/** With no real reset known, wait this long before looking again. */
const FALLBACK_MS = 60 * 60_000;

/** The provider's quota window a refusal's wording names, as readings call it. */
export function limitWindowKey(window: string): string {
  if (/weekly/.test(window)) return "seven_day";
  if (/5-hour|five-hour/.test(window)) return "five_hour";
  return window.replace(/^the /, "").replace(/\s+/g, "_");
}

/** A reading the account itself gave: not BOS-463's made-up one-hour "full" reading. */
const realReading = (s: { observedAt: Date; resetsAt: Date | null }) => !(s.resetsAt && s.resetsAt.getTime() - s.observedAt.getTime() === MADE_UP_MS);

/** The latest real reset time still ahead for a window on an account, if any reading has one. */
export async function lastRealReset(db: Db, fundingSourceId: string, window: string, at: Date): Promise<Date | null> {
  const rows = await db.select().from(quotaSamples).where(and(eq(quotaSamples.fundingSourceId, fundingSourceId), eq(quotaSamples.window, window))).orderBy(desc(quotaSamples.observedAt)).limit(20);
  for (const r of rows) if (realReading(r) && r.resetsAt && r.resetsAt.getTime() > at.getTime()) return r.resetsAt;
  return null;
}

export type LimitRequeueResult = { outcome: "requeued"; wakeId: string; until: Date } | { outcome: "second_refusal"; fundingSourceId: string; account: string; window: string } | { outcome: "not_a_limit" };

export function limitRequeue(db: Db, deps: { now: () => Date }) {
  return {
    /** Called when a run ended with an error. Requeues its wake once per window, or says it is the second refusal. */
    async afterRun(runId: string): Promise<LimitRequeueResult> {
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      const named = run?.outcome ? accountOutage(run.outcome.replace(/^error:\s*/i, "")) : null;
      // A reset won't fix a login or key problem (a credit-balance error is one too).
      if (!run || !named?.window || named.auth || !run.agentId || run.purpose === "chat") return { outcome: "not_a_limit" };
      // The run names its account only when the scheduler picked one from the ranked list; otherwise it is the agent's own.
      const [owner] = run.fundingSourceId ? [] : await db.select({ fundingSourceId: agents.fundingSourceId }).from(agents).where(eq(agents.id, run.agentId));
      const sourceId = run.fundingSourceId ?? owner?.fundingSourceId;
      if (!sourceId) return { outcome: "not_a_limit" };
      const at = run.endedAt ?? deps.now();
      const key = limitWindowKey(named.window);
      const real = await lastRealReset(db, sourceId, key, at);
      // The same agent, ticket and window already requeued once: this is the account's problem, not the wake's.
      const prior = await db
        .select({ detail: activity.detail })
        .from(activity)
        .where(and(eq(activity.kind, LIMIT_REQUEUE_KIND), eq(activity.agentId, run.agentId), run.ticketId ? eq(activity.ticketId, run.ticketId) : sql`${activity.ticketId} is null`, gt(activity.at, new Date(at.getTime() - 14 * 24 * 3_600_000))));
      const sameWindow = prior.some((p) => {
        const d = p.detail as { window?: string; until?: string } | null;
        return d?.window === key && d.until && new Date(d.until).getTime() > at.getTime();
      });
      const [src] = await db.select({ name: fundingSources.name }).from(fundingSources).where(eq(fundingSources.id, sourceId));
      const account = src?.name ?? named.name;
      if (sameWindow) return { outcome: "second_refusal", fundingSourceId: sourceId, account, window: named.window };
      const [w] = await db.select().from(wakes).where(eq(wakes.runId, runId));
      if (!w) return { outcome: "not_a_limit" };
      const until = real ?? new Date(at.getTime() + FALLBACK_MS);
      const reason = `${LIMIT_HELD_PREFIX} waiting for ${account} until ${until.toISOString().slice(0, 16).replace("T", " ")} UTC`;
      const [made] = await db
        .insert(wakes)
        .values({ companyId: w.companyId, agentId: w.agentId, ticketId: w.ticketId, reason: w.reason, note: w.note, priority: w.priority, causationDepth: w.causationDepth, causedByRunId: w.causedByRunId, causedByAgentId: w.causedByAgentId, status: "deferred", statusReason: reason, notBefore: until })
        .returning({ id: wakes.id });
      await record(db, { companyId: w.companyId, agentId: w.agentId, ticketId: w.ticketId, kind: LIMIT_REQUEUE_KIND, summary: `Run refused for ${account}'s ${named.window}; its wake waits until ${until.toISOString()}.`, detail: { window: key, until: until.toISOString(), fundingSourceId: sourceId, wakeId: made!.id }, at: deps.now() });
      return { outcome: "requeued", wakeId: made!.id, until };
    },

    /**
     * Frees limit-held wakes early: the account gave a real reading showing room again, or a run on it
     * finished cleanly, since the wake was held. The 1-hour made-up reading expiring does neither.
     */
    async releaseReady(): Promise<number> {
      const held = await db.select().from(wakes).where(and(eq(wakes.status, "deferred"), like(wakes.statusReason, `${LIMIT_HELD_PREFIX}%`)));
      let n = 0;
      for (const w of held) {
        const [a] = await db.select().from(activity).where(and(eq(activity.kind, LIMIT_REQUEUE_KIND), sql`${activity.detail}->>'wakeId' = ${w.id}`));
        const d = a?.detail as { window?: string; fundingSourceId?: string } | null;
        if (!a || !d?.fundingSourceId || !d.window) continue;
        const [clean] = await db
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.fundingSourceId, d.fundingSourceId), cleanEndSql, gt(runs.endedAt, a.at)))
          .limit(1);
        const readings = await db.select().from(quotaSamples).where(and(eq(quotaSamples.fundingSourceId, d.fundingSourceId), eq(quotaSamples.window, d.window), gt(quotaSamples.observedAt, a.at)));
        const room = readings.some((s) => realReading(s) && s.utilization < 1);
        if (!clean && !room) continue;
        await db.update(wakes).set({ statusReason: null, notBefore: null, status: "queued" }).where(eq(wakes.id, w.id));
        n++;
      }
      return n;
    },
  };
}
