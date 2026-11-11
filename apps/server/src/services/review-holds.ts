// Review holds (BOS-808): a reviewer passes the work but asks that it not merge yet. The review slot stays
// approved (so nothing re-asks for a review); the hold is a separate fact that every path into a merge checks,
// that the sweeps and the watchdog skip, and that the board shows as "Held". It ends by release (the normal
// approve path runs next) or cancel (the reviewer's pass is withdrawn and the work is reviewed again).
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, reviewHolds, reviewHoldWaits, reviewRequests, ticketDependencies, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { goLiveWaitOf } from "./go-live-wait.js";

export type ReviewHold = typeof reviewHolds.$inferSelect;
export const HOLD_WAKE_REASON = "review hold ready";

/** What a hold waits on, as the caller names it: a ticket or a decision by id. */
export type HoldWaitInput = { ticketId: string } | { decisionId: string };

export type HoldWaitView = { kind: "ticket" | "decision"; id: string; label: string; closed: boolean };
export type HoldView = {
  id: string;
  ticketId: string;
  reason: string;
  reviewerAgentId: string | null;
  reviewer: string | null;
  releaseAt: string | null;
  createdAt: string;
  waits: HoldWaitView[];
  /** Every wait has closed, or the date has come: the reviewer has been (or is about to be) asked to re-check. */
  ready: boolean;
  /** One line for a badge: "waits on BOS-12 / until 19 Nov". */
  label: string;
  /** Boss Man placed it (BOS-1173): no reviewer re-checks it; it releases itself once what it waits on is merged and live. */
  system: boolean;
};

/** The ticket's open hold, if any. */
export async function openHold(db: Db, ticketId: string): Promise<ReviewHold | null> {
  const [h] = await db.select().from(reviewHolds).where(and(eq(reviewHolds.ticketId, ticketId), eq(reviewHolds.status, "open")));
  return h ?? null;
}

/** Which of these tickets have an open hold. */
export async function heldTicketIds(db: Db, ticketIds?: string[]): Promise<Set<string>> {
  if (ticketIds && !ticketIds.length) return new Set();
  const rows = await db.select({ ticketId: reviewHolds.ticketId }).from(reviewHolds).where(and(eq(reviewHolds.status, "open"), ticketIds ? inArray(reviewHolds.ticketId, ticketIds) : undefined));
  return new Set(rows.map((r) => r.ticketId));
}

const shortDate = (d: Date) => `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;

/** Creates the hold for a ticket. One open hold per ticket: a second is refused by the caller and the unique index. */
export async function createHold(
  db: Db,
  input: { ticketId: string; reviewRequestId: string | null; reviewerAgentId: string | null; reason: string; releaseAt: Date | null; waits: HoldWaitInput[] },
): Promise<ReviewHold> {
  const [h] = await db
    .insert(reviewHolds)
    .values({ ticketId: input.ticketId, reviewRequestId: input.reviewRequestId, reviewerAgentId: input.reviewerAgentId, reason: input.reason, releaseAt: input.releaseAt })
    .returning();
  if (input.waits.length) {
    await db.insert(reviewHoldWaits).values(input.waits.map((w) => ({ holdId: h!.id, blockerTicketId: "ticketId" in w ? w.ticketId : null, blockerDecisionId: "decisionId" in w ? w.decisionId : null })));
  }
  return h!;
}

/** Closes any open hold without touching the review rows: the round it belonged to is over. */
export async function endHolds(db: Db, ticketId: string, by: string): Promise<void> {
  await db.update(reviewHolds).set({ status: "cancelled", closedBy: by, closedAt: new Date() }).where(and(eq(reviewHolds.ticketId, ticketId), eq(reviewHolds.status, "open")));
}

/** Ends the hold. `released` keeps the review's pass; `cancelled` puts the reviewer's slot back to pending. */
export async function closeHold(db: Db, hold: ReviewHold, how: "released" | "cancelled", by: string): Promise<boolean> {
  const closed = await db.update(reviewHolds).set({ status: how, closedBy: by, closedAt: new Date() }).where(and(eq(reviewHolds.id, hold.id), eq(reviewHolds.status, "open"))).returning({ id: reviewHolds.id });
  if (!closed.length) return false;
  if (how === "cancelled" && hold.reviewRequestId) {
    await db.update(reviewRequests).set({ status: "pending", decidedAt: null }).where(and(eq(reviewRequests.id, hold.reviewRequestId), eq(reviewRequests.status, "approved")));
  }
  return true;
}

type WaitRow = { kind: "ticket" | "decision"; id: string; label: string; closed: boolean };

async function waitsOf(db: Db, holdId: string): Promise<WaitRow[]> {
  const rows = await db.select().from(reviewHoldWaits).where(eq(reviewHoldWaits.holdId, holdId));
  const out: WaitRow[] = [];
  for (const r of rows) {
    if (r.blockerTicketId) {
      const [t] = await db.select({ number: tickets.number, title: tickets.title, state: tickets.systemState, prefix: companies.ticketPrefix }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, r.blockerTicketId));
      out.push({ kind: "ticket", id: r.blockerTicketId, label: (t && ticketRef(t.prefix, t.number)) || t?.title || r.blockerTicketId, closed: !t || t.state === "done" });
    } else if (r.blockerDecisionId) {
      const [d] = await db.select({ status: decisions.status, question: decisions.question }).from(decisions).where(eq(decisions.id, r.blockerDecisionId));
      out.push({ kind: "decision", id: r.blockerDecisionId, label: d ? `decision "${d.question.slice(0, 40)}"` : "a decision", closed: !d || d.status !== "open" });
    }
  }
  return out;
}

/** Whether the hold's condition is met: every wait closed (when there are any), or the date has come. */
export function holdReady(hold: Pick<ReviewHold, "releaseAt">, waits: Array<{ closed: boolean }>, now: Date): boolean {
  const waitsDone = waits.length > 0 && waits.every((w) => w.closed);
  const dateCame = !!hold.releaseAt && hold.releaseAt.getTime() <= now.getTime();
  return waitsDone || dateCame;
}

/** The hold as the board, the ticket page and the review tool show it. */
export async function holdView(db: Db, ticketId: string, now: Date = new Date()): Promise<HoldView | null> {
  const h = await openHold(db, ticketId);
  if (!h) return null;
  const waits = await waitsOf(db, h.id);
  const [reviewer] = h.reviewerAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, h.reviewerAgentId)) : [];
  const open = waits.filter((w) => !w.closed).map((w) => w.label);
  const parts = [open.length ? `waits on ${open.join(", ")}` : "", h.releaseAt ? `until ${shortDate(h.releaseAt)}` : ""].filter(Boolean);
  return {
    id: h.id,
    ticketId,
    reason: h.reason,
    reviewerAgentId: h.reviewerAgentId,
    reviewer: reviewer?.name ?? null,
    releaseAt: h.releaseAt?.toISOString() ?? null,
    createdAt: h.createdAt.toISOString(),
    waits,
    ready: holdReady(h, waits, now),
    label: parts.join(" / ") || "ready to re-check",
    system: !h.reviewerAgentId && !h.reviewRequestId,
  };
}

/**
 * Whether a blocker ticket's change is in force for a merge waiting on it (BOS-1173): closed without merging
 * (nothing left to wait for), or merged and running (the server, and the runners for runner code: a fix to the
 * merge check that the gate's runner doesn't run yet fixes nothing). An open, unmerged ticket is never in force.
 */
export async function ticketInForce(db: Db, ticketId: string): Promise<boolean> {
  const [b] = await db.select({ companyId: tickets.companyId, state: tickets.systemState, mergeCommit: tickets.mergeCommit, touchesRunner: tickets.touchesRunner }).from(tickets).where(eq(tickets.id, ticketId));
  if (!b) return true;
  if (!b.mergeCommit) return b.state === "done";
  return (await goLiveWaitOf(db, b)) === null;
}

/**
 * What an approved ticket's merge waits on before any check runs (BOS-1173, DR-053): its own waits-on links to
 * tickets not yet in force, and any other open ticket in the project marked as fixing the merge check. A ticket
 * marked that way never waits on another such ticket: it is the fix, and its own check must run.
 */
export async function mergeWaits(db: Db, t: { id: string; projectId: string; fixesMergeCheck: boolean }): Promise<string[]> {
  const linked = await db
    .select({ id: ticketDependencies.blockerTicketId })
    .from(ticketDependencies)
    .where(and(eq(ticketDependencies.blockedTicketId, t.id), isNotNull(ticketDependencies.blockerTicketId)));
  const gate = t.fixesMergeCheck
    ? []
    : await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.projectId, t.projectId), eq(tickets.fixesMergeCheck, true), ne(tickets.id, t.id), ne(tickets.systemState, "done")));
  const ids = [...new Set([...linked.map((l) => l.id!), ...gate.map((g) => g.id)])].filter((id) => id !== t.id);
  const out: string[] = [];
  for (const id of ids) if (!(await ticketInForce(db, id))) out.push(id);
  return out;
}

/**
 * Puts an approved ticket in "Passed, held" on these tickets (BOS-1173): Boss Man's own hold, with no reviewer and
 * no review row, so no one is asked to re-check. An open system hold gains any wait it lacks; a reviewer's hold is
 * left alone (it already holds every merge path). Returns the hold, and whether anything was new.
 */
export async function ensureSystemHold(db: Db, ticketId: string, blockerIds: string[], reason: string): Promise<{ hold: ReviewHold; added: boolean }> {
  const open = await openHold(db, ticketId);
  if (open) {
    if (open.reviewerAgentId || open.reviewRequestId) return { hold: open, added: false };
    const have = new Set((await db.select({ id: reviewHoldWaits.blockerTicketId }).from(reviewHoldWaits).where(eq(reviewHoldWaits.holdId, open.id))).map((w) => w.id));
    const missing = blockerIds.filter((id) => !have.has(id));
    if (missing.length) await db.insert(reviewHoldWaits).values(missing.map((id) => ({ holdId: open.id, blockerTicketId: id })));
    return { hold: open, added: missing.length > 0 };
  }
  return { hold: await createHold(db, { ticketId, reviewRequestId: null, reviewerAgentId: null, reason, releaseAt: null, waits: blockerIds.map((id) => ({ ticketId: id })) }), added: true };
}

/**
 * Whether Boss Man ends this hold by itself rather than waking a reviewer (BOS-1173): its own hold, or a reviewer's
 * hold that waits only on tickets fixing the merge check. The code didn't change and the fault was the gate's, so
 * a re-check by hand would be wasted review work.
 */
async function autoReleases(db: Db, h: ReviewHold): Promise<{ auto: boolean; ticketWaits: string[]; decisionWaits: string[] }> {
  const rows = await db.select().from(reviewHoldWaits).where(eq(reviewHoldWaits.holdId, h.id));
  const ticketWaits = rows.flatMap((r) => (r.blockerTicketId ? [r.blockerTicketId] : []));
  const decisionWaits = rows.flatMap((r) => (r.blockerDecisionId ? [r.blockerDecisionId] : []));
  if (!h.reviewerAgentId && !h.reviewRequestId) return { auto: true, ticketWaits, decisionWaits };
  if (!ticketWaits.length || decisionWaits.length) return { auto: false, ticketWaits, decisionWaits };
  const marked = await db.select({ id: tickets.id }).from(tickets).where(and(inArray(tickets.id, ticketWaits), eq(tickets.fixesMergeCheck, true)));
  return { auto: marked.length === ticketWaits.length, ticketWaits, decisionWaits };
}

/**
 * Ends every hold Boss Man releases by itself whose waits are all in force (BOS-1173), and starts each ticket's merge
 * again through `start` (the whole gate, check included, runs on the unchanged head). The approvals and the owner's
 * sign-off stand. Claimed with a conditional close, so two passes never start two merges. Returns the tickets started.
 */
export async function releaseReadyHolds(db: Db, start: (ticketId: string) => Promise<unknown>, ticketId?: string): Promise<string[]> {
  const open = await db.select().from(reviewHolds).where(and(eq(reviewHolds.status, "open"), ticketId ? eq(reviewHolds.ticketId, ticketId) : undefined));
  const started: string[] = [];
  for (const h of open) {
    const a = await autoReleases(db, h);
    if (!a.auto) continue;
    if (a.decisionWaits.length) {
      const openCards = await db.select({ id: decisions.id }).from(decisions).where(and(inArray(decisions.id, a.decisionWaits), eq(decisions.status, "open")));
      if (openCards.length) continue;
    }
    let ready = true;
    for (const id of a.ticketWaits) if (!(await ticketInForce(db, id))) ready = false;
    if (!ready) continue;
    const [t] = await db.select({ id: tickets.id, companyId: tickets.companyId, state: tickets.systemState, projectId: tickets.projectId, fixesMergeCheck: tickets.fixesMergeCheck }).from(tickets).where(eq(tickets.id, h.ticketId));
    if (!t || t.state !== "review") continue;
    // Something new to wait on (another fix marked since): keep it held on that instead.
    const still = await mergeWaits(db, t);
    if (still.length) {
      await ensureSystemHold(db, t.id, still, h.reason);
      continue;
    }
    if (!(await closeHold(db, h, "released", "Boss Man"))) continue;
    await record(db, { companyId: t.companyId, ticketId: t.id, kind: "review_hold_released", summary: "What this merge waited on is merged and live, so Boss Man released the hold and started the merge again. The reviews and any sign-off stand; nothing to do." });
    await start(t.id).catch(() => undefined);
    started.push(t.id);
  }
  return started;
}

/**
 * Wakes the holding reviewer once, when the hold's condition is met (BOS-808). The `wokenAt` stamp is claimed first with a
 * conditional update, so two sweeps (or a sweep and a hook) never wake twice. It starts no merge: the reviewer re-checks
 * against current main and releases, and that goes through the normal approve path.
 */
export async function wakeReadyHolds(db: Db, now: Date, wake: (input: { agentId: string; reason: string; ticketId: string; note: string; priority: number }) => Promise<unknown>, ticketId?: string): Promise<number> {
  const open = await db.select().from(reviewHolds).where(and(eq(reviewHolds.status, "open"), isNull(reviewHolds.wokenAt), ticketId ? eq(reviewHolds.ticketId, ticketId) : undefined));
  let woken = 0;
  for (const h of open) {
    // Boss Man ends these itself once they're in force (releaseReadyHolds, BOS-1173): nobody is asked to re-check.
    if ((await autoReleases(db, h)).auto) continue;
    const waits = await waitsOf(db, h.id);
    if (!holdReady(h, waits, now)) continue;
    const [t] = await db.select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId, number: tickets.number, prefix: companies.ticketPrefix, state: tickets.systemState }).from(tickets).innerJoin(companies, eq(companies.id, tickets.companyId)).where(eq(tickets.id, h.ticketId));
    if (!t || t.state !== "review") continue;
    const claimed = await db.update(reviewHolds).set({ wokenAt: now }).where(and(eq(reviewHolds.id, h.id), isNull(reviewHolds.wokenAt))).returning({ id: reviewHolds.id });
    if (!claimed.length) continue;
    await record(db, { companyId: t.companyId, ticketId: t.id, agentId: h.reviewerAgentId, kind: "review_hold_ready", summary: `The hold on this ticket has run its course (${h.releaseAt && h.releaseAt <= now ? "the date came" : "everything it waited on has closed"}); the reviewer was asked to re-check and release.` });
    if (!h.reviewerAgentId) continue;
    const ref = ticketRef(t.prefix, t.number) ?? t.id;
    await wake({
      agentId: h.reviewerAgentId,
      reason: HOLD_WAKE_REASON,
      ticketId: t.id,
      priority: 3,
      note: `- ${t.id} "${t.title}" (${ref}): you passed this review but held the merge ("${h.reason}"). What it waited for is done. Re-check it against current main (git diff origin/main...HEAD with the review tool's diff action), then use the review tool: action release_hold to let it merge, or action cancel_hold to withdraw your pass and have it reviewed again.`,
    });
    woken++;
  }
  return woken;
}
