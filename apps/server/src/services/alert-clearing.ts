// One closer for every card Boss Man raises itself (DR-016, BOS-470). A card names the conditions
// under which its cause is gone in `context.clearWhen`; this checks them against the database and
// withdraws the card with a one-line reason the owner can read, on any tier: Boss Man is closing
// its own card, not overruling a person. Agent-raised questions have no conditions and are left to
// a person, except an add-on's setup card (raise_decision with setsUp, DR-023 D, BOS-522), which goes
// once that add-on is seen working.
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { decisions, runners, runs, ticketDependencies, tickets, wakes } from "../db/schema.js";
import { record } from "./activity.js";
import { signoffClearedReason } from "./signoff.js";
import { ADDON_LABELS, ADDONS, type Addon, type AddonFacts } from "./addons.js";

/** One machine-checkable reason a card can go: a fixed shape, never free text. */
export type ClearWhen =
  | { kind: "runActive"; runId: string }
  | { kind: "agentRanOk"; agentId: string }
  | { kind: "ticketDone"; ticketId: string }
  | { kind: "ticketLeft"; ticketId: string; state: string }
  /** Start-failure cards name the wake that failed: the runner must be connected and that wake must have started (BOS-475 E). */
  | { kind: "runnerConnected"; companyId: string; wakeId?: string }
  /** Usage-limit cards: the account has room again (the same test as the scheduler's account pick). */
  | { kind: "limitReset"; fundingSourceId: string }
  /**
   * Auth and credit-failure cards: a run on that account has finished cleanly since the card was raised.
   * A revoked key or an empty credit balance leaves the quota windows untouched, so "room again" is true
   * at once; only a clean run proves the credential is fixed (BOS-469, security review).
   */
  | { kind: "accountRanOk"; fundingSourceId: string }
  /**
   * The owner's sign-off card (DR-021): the ticket no longer waits on the sign-off. It was signed off, merged,
   * cancelled or moved out of review, a new review round started, or its risk no longer needs the owner.
   */
  | { kind: "signoffNotWaiting"; ticketId: string }
  /**
   * An add-on's setup card (DR-023 D): the add-on reads running, seen working after the card was raised.
   * "Running" alone isn't enough: Tailscale stays running for a day after its last request and ntfy until
   * the next push fails, so a card raised to fix one that has just broken would close at once on the old
   * reading (the BOS-469 lesson). A request through the edge or a push that went through since then proves it.
   */
  | { kind: "addonRunning"; addon: Addon }
  /** No-progress cards (BOS-593): a work run in that company has finished cleanly since the card was raised. */
  | { kind: "companyRanOk"; companyId: string };

type Card = { id: string; companyId: string; status: string; createdAt: Date; question: string; context: unknown };

/** The conditions on a card, if they are well formed. A value that isn't one of the rows is ignored rather than guessed at. */
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
      case "accountRanOk":
        if (typeof c.fundingSourceId === "string") out.push({ kind: "accountRanOk", fundingSourceId: c.fundingSourceId });
        break;
      case "companyRanOk":
        if (typeof c.companyId === "string") out.push({ kind: "companyRanOk", companyId: c.companyId });
        break;
      case "signoffNotWaiting":
        if (typeof c.ticketId === "string") out.push({ kind: "signoffNotWaiting", ticketId: c.ticketId });
        break;
      case "addonRunning":
        if ((ADDONS as readonly unknown[]).includes(c.addon)) out.push({ kind: "addonRunning", addon: c.addon as Addon });
        break;
      default:
        break;
    }
  }
  return out;
}

export type AlertClearingDeps = {
  /** Whether a runner is connected right now (the runners service knows; the database only has lastSeenAt). */
  isConnected: (runnerId: string) => boolean;
  /** Whether a funding source has room for a new run again; the scheduler's own test, so the two never disagree. */
  hasRoom: (fundingSourceId: string) => Promise<boolean>;
  /** Which add-ons are running (DR-023); without it an add-on setup card stays open. */
  addons?: () => Promise<AddonFacts>;
  /** Moves a ticket that waited on a closed card back to ready once nothing else holds it, and wakes its assignee. */
  release?: (ticketId: string) => Promise<unknown>;
  now?: () => Date;
};

const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const ago = (ms: number) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} hours` : `${Math.max(1, Math.floor(ms / 60_000))} minutes`);

export function alertClearing(db: Db, deps: AlertClearingDeps) {
  const now = deps.now ?? (() => new Date());

  /** Plain words for why a condition has stopped being true, or null while it still holds. */
  async function reasonIfCleared(c: ClearWhen, card: Card, addonFacts: () => Promise<AddonFacts | null>): Promise<string | null> {
    switch (c.kind) {
      case "runActive": {
        const [r] = await db.select({ endedAt: runs.endedAt, lastEventAt: runs.lastEventAt, outcome: runs.outcome }).from(runs).where(eq(runs.id, c.runId));
        if (!r) return "the run is no longer on record";
        if (r.endedAt) return `the run ended${(r.outcome ?? "").match(/^(error:|lost:|interrupted)/) ? "" : " normally"} at ${hhmm(r.endedAt)}`;
        if (r.lastEventAt && r.lastEventAt.getTime() > card.createdAt.getTime()) return "the run is active again";
        return null;
      }
      case "agentRanOk": {
        // A run that finished without an error, since the card was raised, with no new trip of the same
        // guard after it (a fresh trip frees the key and raises a fresh card, DR-016 E).
        const [clean] = await db
          .select({ endedAt: runs.endedAt, outcome: runs.outcome })
          .from(runs)
          .where(and(eq(runs.agentId, c.agentId), gt(runs.startedAt, card.createdAt), sql`${runs.endedAt} is not null`, sql`coalesce(${runs.outcome}, '') not like 'error:%'`, sql`coalesce(${runs.outcome}, '') not like 'lost:%'`, sql`coalesce(${runs.outcome}, '') not like 'interrupted'`))
          .orderBy(runs.endedAt)
          .limit(1);
        if (!clean?.endedAt) return null;
        return `the agent finished a clean run at ${hhmm(clean.endedAt)}`;
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
      case "runnerConnected": {
        const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, c.companyId));
        if (!runner || !deps.isConnected(runner.id)) return null;
        if (!c.wakeId) return "the runner is connected again";
        // The failed wake must have been started since the card was raised, or nothing was fixed (BOS-475 E).
        // A wake's runId is set when its run is launched (and null again when it ends without one).
        const [wake] = await db.select({ runId: wakes.runId, createdAt: wakes.createdAt }).from(wakes).where(eq(wakes.id, c.wakeId));
        return wake?.runId ? "the runner is connected again and the wake has started" : null;
      }
      case "limitReset": {
        return (await deps.hasRoom(c.fundingSourceId)) ? "the account has room again" : null;
      }
      case "accountRanOk": {
        // A run on this account that finished without an error, since the card was raised. Only that proves
        // a revoked key, a logged-out session or an empty credit balance is fixed (BOS-469, security review).
        const [clean] = await db
          .select({ endedAt: runs.endedAt })
          .from(runs)
          .where(and(eq(runs.fundingSourceId, c.fundingSourceId), gt(runs.startedAt, card.createdAt), sql`${runs.endedAt} is not null`, sql`coalesce(${runs.outcome}, '') not like 'error:%'`, sql`coalesce(${runs.outcome}, '') not like 'lost:%'`, sql`coalesce(${runs.outcome}, '') not like 'interrupted'`))
          .orderBy(runs.endedAt)
          .limit(1);
        return clean?.endedAt ? `a run on the account succeeded at ${hhmm(clean.endedAt)}` : null;
      }
      case "companyRanOk": {
        // Ended after the card, not started after it: a long run that was going all along and then finishes
        // cleanly is the company moving again. Chat runs, stopped or cancelled runs, and the CEO run that
        // only read the card (origin "decision") are not progress: the last would close the card at once.
        const [clean] = await db
          .select({ endedAt: runs.endedAt })
          .from(runs)
          .where(and(eq(runs.companyId, c.companyId), gt(runs.endedAt, card.createdAt), sql`${runs.purpose} is distinct from 'chat'`, sql`${runs.origin} is distinct from 'decision'`, sql`coalesce(${runs.outcome}, '') not like 'error:%'`, sql`coalesce(${runs.outcome}, '') not like 'lost:%'`, sql`coalesce(${runs.outcome}, '') not in ('interrupted', 'cancelled')`, sql`coalesce(${runs.outcome}, '') not like 'stopped%'`))
          .orderBy(runs.endedAt)
          .limit(1);
        return clean?.endedAt ? `a run there finished cleanly at ${hhmm(clean.endedAt)}` : null;
      }
      case "signoffNotWaiting":
        return signoffClearedReason(db, c.ticketId);
      case "addonRunning": {
        const f = (await addonFacts())?.[c.addon];
        if (f?.state !== "running" || !f.since) return null;
        const since = new Date(f.since);
        if (!(since.getTime() > card.createdAt.getTime())) return null;
        return `${ADDON_LABELS[c.addon]} is running (${f.source}, at ${hhmm(since)})`;
      }
      default:
        return null;
    }
  }

  /**
   * Closes every open card whose conditions have all cleared, on any tier, with the reasons in
   * `context.withdrawn`. Pass cards to check a handful, or nothing for every open card that carries
   * a condition. Returns how many it closed.
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
    // Read once per pass, and only if a card asks: a failed read leaves those cards open.
    let facts: Promise<AddonFacts | null> | undefined;
    const addonFacts = () => (facts ??= deps.addons ? deps.addons().catch(() => null) : Promise.resolve(null));
    for (const row of rows) {
      if (row.status !== "open") continue;
      const clearWhen = clearWhenOf(row.context);
      // A card with no readable condition is left exactly as it is: no hedge, no guessing.
      if (!clearWhen.length) continue;
      // The conditions are alternatives: the card goes as soon as any one is true (a stalled run whose
      // run stirred, or whose ticket finished). Every true one is named in the reason.
      const reasons: string[] = [];
      for (const c of clearWhen) {
        const reason = await reasonIfCleared(c, row, addonFacts);
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
      // A sign-off card holds its ticket: the hold goes with it, or the ticket would stay blocked on a closed card.
      if ((row.context as { type?: string } | null)?.type === "risk_review") await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, row.id));
      closed++;
      // A ticket that waited on the card (a setup card raised with blocksTicketId) waits no longer, the
      // same as when its raiser withdraws it; its assignee is woken with the news.
      const freed = await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, row.id)).returning({ ticketId: ticketDependencies.blockedTicketId });
      for (const f of freed) if (f.ticketId) await deps.release?.(f.ticketId);
      // Named on that ticket's activity too, so the owner reads there that it's done.
      const ticketId = freed.find((f) => f.ticketId)?.ticketId;
      await record(db, { companyId: row.companyId, ...(ticketId ? { ticketId } : {}), kind: "decision_withdrawn", summary: `Boss Man closed "${done.question.slice(0, 120)}" by itself: ${note}`, at: t });
    }
    return closed;
  }

  /**
   * The permission card a run is waiting on, if its last word was that permission request (BOS-470
   * point 3): a run that is waiting for the owner to answer was told to stop by Boss Man's own
   * permission rule, so it is not stalled. Null when it is not waiting on one.
   */
  async function waitingOnPermission(runId: string): Promise<{ id: string; title: string | null; askedAt: Date } | null> {
    const [perm] = await db
      .select({ id: decisions.id, question: decisions.question, createdAt: decisions.createdAt })
      .from(decisions)
      .where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open"), sql`${decisions.context}->>'runId' = ${runId}`))
      .limit(1);
    return perm ? { id: perm.id, title: perm.question, askedAt: perm.createdAt } : null;
  }

  return { check, waitingOnPermission };
}
