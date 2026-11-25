// The one rule for which tickets belong to a milestone (BOS-2560): the tickets put directly in it, plus every
// ticket of its features. The roadmap's counts, status, forecast and burn-up, the milestone's ticket list and the
// CSV (built from those counts in the browser) all read through this, so one milestone never shows two answers.
// A ticket that names a milestone itself counts there, even when its feature sits under another one.
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, companies, features, tickets } from "../db/schema.js";

export type MilestoneTicket = {
  id: string;
  title: string;
  /** The milestone the ticket counts under. */
  milestoneId: string;
  state: string;
  outcome: string | null;
  assignee: string | null;
  size: number | null;
  createdAt: Date;
  changedAt: Date;
  /** The ticket's reference, e.g. BOS-12 (BOS-2579: the roadmap's reason line names tickets). */
  ref: string;
  /** Merge facts: a merged ticket with no go-live wait is live (BOS-2579 counts it as delivered). */
  mergeCommit: string | null;
  goLiveWait: string | null;
  watchUntil: Date | null;
};

/** Tickets of the given milestones, each tagged with the milestone it counts under. Cancelled ones only when asked. */
export async function ticketsOfMilestones(db: Db, milestoneIds: string[], opts: { includeCancelled?: boolean } = {}): Promise<MilestoneTicket[]> {
  if (!milestoneIds.length) return [];
  const feats = await db.select({ id: features.id, milestoneId: features.milestoneId }).from(features).where(inArray(features.milestoneId, milestoneIds));
  const msOfFeature = new Map(feats.map((f) => [f.id, f.milestoneId!]));
  const rows = await db
    .select({
      id: tickets.id,
      title: tickets.title,
      milestoneId: tickets.milestoneId,
      featureId: tickets.featureId,
      state: tickets.systemState,
      outcome: tickets.outcome,
      assignee: agents.name,
      size: tickets.size,
      createdAt: tickets.createdAt,
      changedAt: tickets.stateChangedAt,
      number: tickets.number,
      prefix: companies.ticketPrefix,
      mergeCommit: tickets.mergeCommit,
      goLiveWait: tickets.goLiveWait,
      watchUntil: tickets.watchUntil,
    })
    .from(tickets)
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
    .where(and(opts.includeCancelled ? undefined : sql`${tickets.outcome} is distinct from 'cancelled'`, or(inArray(tickets.milestoneId, milestoneIds), feats.length ? inArray(tickets.featureId, feats.map((f) => f.id)) : undefined)))
    .orderBy(asc(tickets.createdAt));
  const out: MilestoneTicket[] = [];
  for (const r of rows) {
    const msId = r.milestoneId && milestoneIds.includes(r.milestoneId) ? r.milestoneId : r.featureId ? msOfFeature.get(r.featureId) : undefined;
    if (msId) out.push({ id: r.id, title: r.title, milestoneId: msId, state: r.state, outcome: r.outcome, assignee: r.assignee, size: r.size, createdAt: r.createdAt, changedAt: r.changedAt, ref: `${r.prefix}-${r.number}`, mergeCommit: r.mergeCommit, goLiveWait: r.goLiveWait, watchUntil: r.watchUntil });
  }
  return out;
}
