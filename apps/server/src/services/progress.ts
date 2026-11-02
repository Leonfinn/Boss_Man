// The progress contract (BOS-314, Arch fix 8): what Boss Man does when work goes quiet.
// - a working run with no post on its ticket is asked for a status, then flagged to the Scrum Master;
// - a review whose reviewer ended two runs without a verdict moves to another reviewer, and the CEO is told;
// - an in-progress ticket whose note still says "likely / not proven" for hours goes to the CEO.
// A failed start is handled where the start happens (the scheduler). Every rule fires once per
// run, review or note, and works whether or not the watchdog is switched on.
import { and, eq, inArray, isNotNull, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import { readWatchdogSettings, ruleFor, type ReviewSlot, type WatchdogSettings } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, reviewRequests, runs, tickets, wakes } from "../db/schema.js";
import { record } from "./activity.js";
import type { AlertInput } from "./alert-ladder.js";
import { activeRows, latestRows, REVIEW_REASON, wakeReviewers, type Notify } from "./review-kinds.js";
import { effectivePolicy, otherReviewers } from "./review-policy.js";

/** The reason on the note Boss Man steers into a silent run. */
export const STATUS_REASON = "status check";

/** A state note that admits the cause is a guess. */
export const UNPROVEN_NOTE = /\b(likely|not proven|unproven|unconfirmed)\b/i;

const MIN = 60_000;
const ago = (ms: number) => (ms >= 2 * 3_600_000 ? `${Math.floor(ms / 3_600_000)} hours` : `${Math.max(1, Math.floor(ms / MIN))} minutes`);

/** Which step a run's silence has reached: none yet, ask for a status, or flag it. Pure, so the sweep and tests agree. */
export function silentStage(silentMs: number, s: Pick<WatchdogSettings, "silentSteerMinutes" | "silentFlagMinutes">): "ok" | "steer" | "flag" {
  if (silentMs >= s.silentFlagMinutes * MIN) return "flag";
  return silentMs >= s.silentSteerMinutes * MIN ? "steer" : "ok";
}

/** Stamps a post on a ticket: the ticket's and the posting run's last-post time. */
export async function stampPost(db: Db, input: { runId?: string | null; ticketId?: string | null; at?: Date }) {
  const at = input.at ?? new Date();
  if (input.ticketId) await db.update(tickets).set({ lastPostAt: at }).where(eq(tickets.id, input.ticketId));
  if (input.runId) await db.update(runs).set({ lastPostAt: at }).where(eq(runs.id, input.runId));
}

export type ProgressDeps = {
  wake: (input: { agentId: string; ticketId?: string | null; reason: string; note?: string | null; priority?: number; causedByRunId?: string | null }) => Promise<unknown>;
  alert: (input: AlertInput) => Promise<{ id: string } | null>;
};

export async function progressSweep(db: Db, t: Date, deps: ProgressDeps) {
  const result = { steered: 0, flagged: 0, reviewsMoved: 0, unproven: 0 };
  const companyRows = await db.select({ id: companies.id, watchdog: companies.watchdog }).from(companies).where(eq(companies.paused, false));
  const settings = new Map(companyRows.map((c) => [c.id, readWatchdogSettings(c.watchdog)]));
  const active = (companyId: string) => settings.get(companyId)?.progressContract === true;
  if (![...settings.values()].some((s) => s.progressContract)) return result;

  // A run waiting on a permission answer is waiting on the owner, not silent.
  const waiting = new Set(
    (await db.select({ context: decisions.context }).from(decisions).where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open")))).map((d) => (d.context as { runId?: string }).runId),
  );

  // 1. Silent working runs.
  const live = await db
    .select({ run: runs, agentName: agents.name, title: tickets.title })
    .from(runs)
    .innerJoin(tickets, eq(tickets.id, runs.ticketId))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(and(isNull(runs.endedAt), isNotNull(runs.agentId), inArray(tickets.systemState, ["in_progress", "review"]), or(isNull(runs.purpose), ne(runs.purpose, "chat"))));
  for (const { run, agentName, title } of live) {
    if (!active(run.companyId) || waiting.has(run.id)) continue;
    const s = settings.get(run.companyId)!;
    const since = run.lastPostAt && run.lastPostAt > run.startedAt ? run.lastPostAt : run.startedAt;
    const silent = t.getTime() - since.getTime();
    const stage = silentStage(silent, s);
    if (stage === "ok") continue;
    if (!run.silentSteeredAt) {
      // Claim it first, so two passes can't both ask.
      const [claimed] = await db.update(runs).set({ silentSteeredAt: t }).where(and(eq(runs.id, run.id), isNull(runs.silentSteeredAt))).returning({ id: runs.id });
      if (claimed) {
        await deps.wake({
          agentId: run.agentId!,
          ticketId: run.ticketId,
          reason: STATUS_REASON,
          priority: 2,
          note: `You haven't posted on this ticket for ${ago(silent)}. Post a short status now with ticket_reply: what is done, what you are doing, and anything blocking you. Then carry on.`,
        });
        result.steered++;
      }
    }
    if (stage === "flag") {
      const row = await deps.alert({
        companyId: run.companyId,
        kind: "question",
        question: `${agentName ?? "An agent"} has been working on "${title}" for ${ago(silent)} without posting anything on the ticket. Boss Man asked for a status and got none. Check what it is doing, or stop the run.`,
        options: ["Got it"],
        recommended: "Got it",
        from: "scrum_master",
        duty: true,
        ticketId: run.ticketId,
        about: [run.agentId],
        raisedByAgentId: run.agentId,
        dedupeKey: `silent:${run.id}`,
        context: { type: "question" },
      });
      if (row) result.flagged++;
    }
  }

  // 2. Reviews whose reviewer ended two runs without a verdict.
  const pending = await db
    .selectDistinct({ ticket: tickets })
    .from(reviewRequests)
    .innerJoin(tickets, eq(tickets.id, reviewRequests.ticketId))
    .where(and(eq(reviewRequests.status, "pending"), eq(tickets.systemState, "review")));
  const notify: Notify = (agentId, input) => deps.wake({ agentId, ...input });
  for (const { ticket } of pending) {
    if (!active(ticket.companyId)) continue;
    for (const r of activeRows(await latestRows(db, ticket.id))) {
      if (!r.reviewerAgentId) continue;
      // Runs that ended after the review was asked for, on a wake that named this ticket.
      const [silent] = await db
        .select({ n: sql<number>`count(distinct ${runs.id})::int` })
        .from(runs)
        .innerJoin(wakes, eq(wakes.runId, runs.id))
        .where(and(eq(runs.agentId, r.reviewerAgentId), isNotNull(runs.endedAt), sql`${runs.startedAt} >= ${r.createdAt}`, eq(wakes.reason, REVIEW_REASON), like(wakes.note, `%- ${ticket.id} %`)));
      if ((silent?.n ?? 0) < 2) continue;
      const [from] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, r.reviewerAgentId));
      const rule = ruleFor(await effectivePolicy(db, ticket), ticket.risk);
      const ref = r.kind === "code" ? rule.reviewer : rule.kinds?.[r.kind as Exclude<ReviewSlot, "code">];
      const [to] = ref ? await otherReviewers(db, ticket.companyId, r.kind as ReviewSlot, ref, ticket.assigneeAgentId, [r.reviewerAgentId]) : [];
      const told = await deps.alert({
        companyId: ticket.companyId,
        kind: "question",
        question: to
          ? `${from?.name ?? "The reviewer"} ended ${silent!.n} runs on the ${r.kind} review of "${ticket.title}" without giving a verdict, so the review moved to ${to.name}. Nothing to do unless it happens again.`
          : `${from?.name ?? "The reviewer"} ended ${silent!.n} runs on the ${r.kind} review of "${ticket.title}" without giving a verdict, and no other qualified reviewer is free to take it. Look into it, or move the ticket on yourself.`,
        options: ["Got it"],
        recommended: "Got it",
        from: "ceo",
        ticketId: ticket.id,
        about: [r.reviewerAgentId],
        dedupeKey: `review-silent:${r.id}:${r.reviewerAgentId}`,
        context: { type: "question" },
      });
      if (!told || !to) continue;
      await db.update(reviewRequests).set({ reviewerAgentId: to.id }).where(eq(reviewRequests.id, r.id));
      await record(db, { companyId: ticket.companyId, agentId: r.reviewerAgentId, ticketId: ticket.id, kind: "review_handover", summary: `${from?.name ?? "The reviewer"} ended ${silent!.n} runs without a verdict, so ${to.name} takes the ${r.kind} review`, at: t });
      await wakeReviewers(db, ticket, [{ ...r, reviewerAgentId: to.id }], notify);
      result.reviewsMoved++;
    }
  }

  // 3. A cause left "likely / not proven" for hours.
  for (const [companyId, s] of settings) {
    if (!s.progressContract) continue;
    const stale = await db
      .select({ id: tickets.id, title: tickets.title, note: tickets.stateNote, at: tickets.stateNoteAt, assignee: tickets.assigneeAgentId })
      .from(tickets)
      .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "in_progress"), isNotNull(tickets.stateNote), lte(tickets.stateNoteAt, new Date(t.getTime() - s.unprovenHours * 3_600_000))));
    for (const x of stale) {
      if (!x.note || !x.at || !UNPROVEN_NOTE.test(x.note)) continue;
      const row = await deps.alert({
        companyId,
        kind: "question",
        question: `"${x.title}" has said its cause is only "likely / not proven" for ${ago(t.getTime() - x.at.getTime())}. Reassign it, or call the architect to settle the cause.`,
        options: ["Got it"],
        recommended: "Got it",
        from: "ceo",
        ticketId: x.id,
        about: [x.assignee],
        dedupeKey: `unproven:${x.id}:${x.at.getTime()}`,
        context: { type: "question" },
      });
      if (row) result.unproven++;
    }
  }
  return result;
}
