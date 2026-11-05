// One closer for Boss Man's own alert cards (DR-016, BOS-469 point 2). A card names the conditions under
// which its cause is gone in `context.clearWhen`; this checks them against the database and withdraws the
// card, on any tier (the owner's included), with a one-line reason the owner can read. Boss Man is closing
// its own card, not overruling a person, so no tier blocks it.
//
// The condition rows are declared with the alert kinds that use them (alert-kinds.ts), so a kind carries
// its own closer. BOS-470 builds the wider closer this shares; the shape here is the same, so the two meet.
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions, runs, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import type { ClearWhen } from "./alert-kinds.js";

export type { ClearWhen } from "./alert-kinds.js";

type Card = { id: string; companyId: string; status: string; createdAt: Date; question: string; context: unknown };

/** The conditions on a card, if they are well formed. A value that isn't one of the rows is ignored, never guessed at. */
export function clearWhenOf(context: unknown): ClearWhen[] {
  const raw = (context as { clearWhen?: unknown } | null)?.clearWhen;
  if (!Array.isArray(raw)) return [];
  const out: ClearWhen[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const c = x as Record<string, unknown>;
    switch (c.kind) {
      case "runActive":
        if (typeof c.runId === "string") out.push({ kind: "runActive", runId: c.runId });
        break;
      case "agentRanOk":
        if (typeof c.agentId === "string") out.push({ kind: "agentRanOk", agentId: c.agentId });
        break;
      case "ticketDone":
        if (typeof c.ticketId === "string") out.push({ kind: "ticketDone", ticketId: c.ticketId });
        break;
      case "ticketLeft":
        if (typeof c.ticketId === "string" && typeof c.state === "string") out.push({ kind: "ticketLeft", ticketId: c.ticketId, state: c.state });
        break;
      case "runnerConnected":
        if (typeof c.companyId === "string") out.push({ kind: "runnerConnected", companyId: c.companyId, ...(typeof c.wakeId === "string" ? { wakeId: c.wakeId } : {}) });
        break;
      case "limitReset":
        if (typeof c.fundingSourceId === "string") out.push({ kind: "limitReset", fundingSourceId: c.fundingSourceId });
        break;
      default:
        break;
    }
  }
  return out;
}

export type AlertClearingDeps = {
  /** Whether a funding source has room for a new run again: the scheduler's own test, so the two never disagree. */
  hasRoom: (fundingSourceId: string) => Promise<boolean>;
  /** Whether a runner is connected right now (the runners service knows; the database only has lastSeenAt). */
  isConnected?: (runnerId: string) => boolean;
  now?: () => Date;
};

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

export function alertClearing(db: Db, deps: AlertClearingDeps) {
  const now = deps.now ?? (() => new Date());

  /** Plain words for why a condition has stopped being true, or null while it still holds. */
  async function reasonIfCleared(c: ClearWhen, card: Card): Promise<string | null> {
    switch (c.kind) {
      case "runActive": {
        const [r] = await db.select({ endedAt: runs.endedAt, lastEventAt: runs.lastEventAt }).from(runs).where(eq(runs.id, c.runId));
        if (!r) return "the run is no longer on record";
        if (r.endedAt) return `the run ended at ${hhmm(r.endedAt)}`;
        if (r.lastEventAt && r.lastEventAt.getTime() > card.createdAt.getTime()) return "the run is active again";
        return null;
      }
      case "agentRanOk": {
        // A run that finished without an error, since the card was raised (DR-017 E).
        const [clean] = await db
          .select({ endedAt: runs.endedAt })
          .from(runs)
          .where(and(eq(runs.agentId, c.agentId), gt(runs.startedAt, card.createdAt), sql`${runs.endedAt} is not null`, sql`coalesce(${runs.outcome}, '') not like 'error:%'`, sql`coalesce(${runs.outcome}, '') not like 'lost:%'`, sql`coalesce(${runs.outcome}, '') not like 'interrupted'`))
          .orderBy(runs.endedAt)
          .limit(1);
        return clean?.endedAt ? `the agent finished a clean run at ${hhmm(clean.endedAt)}` : null;
      }
      case "ticketDone": {
        const [t] = await db.select({ state: tickets.systemState, title: tickets.title }).from(tickets).where(eq(tickets.id, c.ticketId));
        if (!t) return "the ticket is no longer on record";
        return t.state === "done" ? `the ticket "${t.title}" is finished` : null;
      }
      case "ticketLeft": {
        const [t] = await db.select({ state: tickets.systemState, title: tickets.title }).from(tickets).where(eq(tickets.id, c.ticketId));
        if (!t) return "the ticket is no longer on record";
        return t.state !== c.state ? `the ticket "${t.title}" is ${t.state === "done" ? "finished" : `now ${t.state.replace("_", " ")}`}` : null;
      }
      case "runnerConnected":
        // The wider runner check is BOS-470's; here the account and run conditions are what this ticket closes on.
        return null;
      case "limitReset":
        return (await deps.hasRoom(c.fundingSourceId)) ? "the account has room again" : null;
      default:
        return null;
    }
  }

  /**
   * Closes every open card whose conditions have cleared, on any tier, with the reasons in
   * `context.withdrawn`. Pass cards to check a handful, or nothing for every open card that carries one.
   * Returns how many it closed.
   */
  async function check(cards?: Card[]): Promise<number> {
    const t = now();
    const rows =
      cards ??
      (await db
        .select({ id: decisions.id, companyId: decisions.companyId, status: decisions.status, createdAt: decisions.createdAt, question: decisions.question, context: decisions.context })
        .from(decisions)
        .where(and(eq(decisions.status, "open"), sql`jsonb_typeof(${decisions.context}->'clearWhen') = 'array'`)));
    let closed = 0;
    for (const row of rows) {
      if (row.status !== "open") continue;
      const clearWhen = clearWhenOf(row.context);
      if (!clearWhen.length) continue;
      // The conditions are alternatives: the card goes as soon as any one is true, and every true one is named.
      const reasons: string[] = [];
      for (const c of clearWhen) {
        const reason = await reasonIfCleared(c, row);
        if (reason) reasons.push(reason);
      }
      if (!reasons.length) continue;
      const note = [...new Set(reasons)].join(", and ");
      const [done] = await db
        .update(decisions)
        .set({ status: "withdrawn", answeredAt: t, dedupeKey: null, context: { ...(row.context as object), withdrawn: { by: "system", note, at: t.toISOString() } } })
        .where(and(eq(decisions.id, row.id), eq(decisions.status, "open")))
        .returning({ id: decisions.id, question: decisions.question });
      if (!done) continue;
      closed++;
      await record(db, { companyId: row.companyId, kind: "decision_withdrawn", summary: `Boss Man closed "${done.question.slice(0, 120)}" by itself: ${note}`, at: t });
    }
    return closed;
  }

  return { check };
}
