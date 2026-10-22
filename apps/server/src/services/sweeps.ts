// Periodic sweeps that put forgotten work in front of the owner:
// - stale blockers (R21): a dependency whose blocker has had no activity for too long;
// - stalled runs (R32): a running agent that has gone quiet. Advisory only: nothing is cancelled
//   (but a run the runner has lost, or a cancel it never confirmed, is ended by the server);
// - missed work (R82): an assigned ticket that is ready to go but that nobody is working on;
// - stalled reviews: a review whose reviewer was woken but never gave a verdict.
// Rows that no longer apply are withdrawn, so the queue only shows live problems.
import { and, desc, eq, gt, inArray, isNotNull, isNull, like, lte, max, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, engagementMessages, engagements, keyResults, milestones, objectives, reviewRequests, runners, runs, ticketDependencies, tickets, wakes } from "../db/schema.js";
import { CANCEL_RUN, CHASE, DROP, KEEP_WAITING, REASSIGN, type DecisionContext } from "./decisions.js";
import { getHold } from "./maintenance.js";
import { activeRows, latestRows } from "./review-kinds.js";
import { MISSED_REASON, REVIEW_REASON, type WakeInput } from "./scheduler.js";

export type SweepLimits = {
  staleAfterMs: number;
  stallAfterMs: number;
  /** A ready, assigned ticket with no activity for this long counts as forgotten (R82). */
  missedAfterMs: number;
  /** An agent is nudged about the same ticket at most once per this long (R82). */
  missedEveryMs: number;
  /** "Keep waiting" holds a stall alert off for this long; if the run is still quiet it is raised again. */
  keepWaitingMs: number;
  /** A run whose runner is offline (or never reported it) this long past the stall limit is ended by the server. */
  lostAfterMs: number;
};
export const DEFAULT_SWEEP_LIMITS: SweepLimits = { staleAfterMs: 24 * 3_600_000, stallAfterMs: 5 * 60_000, missedAfterMs: 30 * 60_000, missedEveryMs: 4 * 3_600_000, keepWaitingMs: 30 * 60_000, lostAfterMs: 30 * 60_000 };
// After this many nudges in a day the owner is told instead (R82).
const MISSED_NUDGES_PER_DAY = 2;

const ago = (ms: number) => (ms >= 2 * 86_400_000 ? `${Math.floor(ms / 86_400_000)} days` : ms >= 2 * 3_600_000 ? `${Math.floor(ms / 3_600_000)} hours` : `${Math.max(1, Math.floor(ms / 60_000))} minutes`);
const later = (a: Date | null | undefined, b: Date | null | undefined) => (!a ? (b ?? null) : !b || a > b ? a : b);

export function sweepService(db: Db, opts: { limits?: Partial<SweepLimits>; now?: () => Date; wake: (input: WakeInput) => Promise<unknown>; isConnected: (runnerId: string) => boolean; endRun: (runId: string, outcome: string, at: Date) => Promise<unknown>; endUnconfirmedCancels: (t: Date) => Promise<unknown> }) {
  const limits = { ...DEFAULT_SWEEP_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());

  async function withdraw(ids: string[]) {
    if (ids.length) await db.update(decisions).set({ status: "withdrawn", dedupeKey: null }).where(inArray(decisions.id, ids));
  }

  async function openOfKind(kind: "stale_blocker" | "stalled_run") {
    return db.select().from(decisions).where(and(eq(decisions.kind, kind), eq(decisions.status, "open")));
  }

  async function staleBlockers(t: Date) {
    const deps = await db
      .select({ dep: ticketDependencies, blocked: tickets })
      .from(ticketDependencies)
      .innerJoin(tickets, eq(tickets.id, ticketDependencies.blockedTicketId));
    const stale = new Map<string, { question: string; options: string[]; recommended: string; companyId: string; ctx: DecisionContext }>();

    // A ticket counts as active if it moved recently or an agent is reporting on it.
    const runActivity = new Map(
      (await db.select({ ticketId: runs.ticketId, at: max(runs.lastEventAt) }).from(runs).groupBy(runs.ticketId)).flatMap((r) => (r.ticketId && r.at ? [[r.ticketId, r.at] as const] : [])),
    );
    const msgActivity = new Map(
      (await db.select({ id: engagementMessages.engagementId, at: max(engagementMessages.createdAt) }).from(engagementMessages).groupBy(engagementMessages.engagementId)).map((r) => [r.id, r.at]),
    );

    for (const { dep, blocked } of deps) {
      if (blocked.systemState === "done" || dep.blockerDecisionId) continue; // decisions are already in the queue
      const ctx: DecisionContext = { type: "stale_blocker", dependencyId: dep.id, blockedTicketId: blocked.id, blockerTicketId: dep.blockerTicketId, blockerEngagementId: dep.blockerEngagementId };
      if (dep.blockerTicketId) {
        const [b] = await db.select({ t: tickets, assignee: agents.name }).from(tickets).leftJoin(agents, eq(agents.id, tickets.assigneeAgentId)).where(eq(tickets.id, dep.blockerTicketId));
        if (!b || b.t.systemState === "done") continue;
        const idle = t.getTime() - later(b.t.lastActivityAt, runActivity.get(b.t.id))!.getTime();
        if (idle < limits.staleAfterMs) continue;
        const who = b.assignee ? `assigned to ${b.assignee}` : b.t.assignedToOwner ? "assigned to you" : "unassigned";
        stale.set(dep.id, {
          question: `"${b.t.title}" (${who}) has blocked "${blocked.title}" with no activity for ${ago(idle)}.`,
          options: [CHASE, REASSIGN, DROP],
          // Nobody to chase means it needs an owner.
          recommended: b.t.assigneeAgentId || b.t.assignedToOwner ? CHASE : REASSIGN,
          companyId: blocked.companyId,
          ctx,
        });
      } else if (dep.blockerEngagementId) {
        const [e] = await db.select().from(engagements).where(eq(engagements.id, dep.blockerEngagementId));
        if (!e || e.status === "signed_off") continue;
        const idle = t.getTime() - later(e.createdAt, msgActivity.get(e.id))!.getTime();
        if (idle < limits.staleAfterMs) continue;
        stale.set(dep.id, {
          question: `The engagement "${e.title}" (${e.status.replace("_", " ")}) has blocked "${blocked.title}" with no activity for ${ago(idle)}.`,
          options: [CHASE, DROP],
          recommended: e.status === "rejected" ? DROP : CHASE,
          companyId: blocked.companyId,
          ctx,
        });
      }
    }

    // Withdraw rows that no longer apply, then raise new ones (one open row per dependency).
    const open = await openOfKind("stale_blocker");
    await withdraw(open.filter((d) => !stale.has((d.context as { dependencyId: string }).dependencyId)).map((d) => d.id));
    const have = new Set(open.map((d) => (d.context as { dependencyId: string }).dependencyId));
    let raised = 0;
    for (const [depId, s] of stale) {
      if (have.has(depId)) continue;
      const rows = await db
        .insert(decisions)
        .values({ companyId: s.companyId, kind: "stale_blocker", question: s.question, options: s.options, recommendedOption: s.recommended, dedupeKey: `stale:${depId}`, context: s.ctx })
        .onConflictDoNothing()
        .returning({ id: decisions.id });
      raised += rows.length;
    }
    return { open: stale.size, raised };
  }

  /** A run waiting on a permission decision is waiting on the owner, not stalled or lost. */
  async function waitingOnOwner() {
    return new Set(
      (await db.select({ context: decisions.context }).from(decisions).where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open")))).map(
        (d) => (d.context as { runId: string }).runId,
      ),
    );
  }

  /**
   * Runs nobody can vouch for any more: quiet well past the stall limit, and the runner is
   * offline or never reported the run. The server ends them; the stall alert is then withdrawn.
   * A run on a connected runner that has sent anything is left alone, however long its command.
   */
  async function lostRuns(t: Date) {
    const live = await db
      .select({ run: runs, runnerId: runners.id })
      .from(runs)
      .leftJoin(runners, eq(runners.companyId, runs.companyId))
      .where(isNull(runs.endedAt));
    const waiting = await waitingOnOwner();
    let ended = 0;
    for (const r of live) {
      if (waiting.has(r.run.id)) continue;
      const idle = t.getTime() - (r.run.lastEventAt ?? r.run.startedAt).getTime();
      if (idle < limits.stallAfterMs + limits.lostAfterMs) continue;
      if (r.runnerId && opts.isConnected(r.runnerId) && r.run.lastEventAt) continue;
      await opts.endRun(r.run.id, r.run.lastEventAt ? "lost: runner offline" : "lost: never started", t);
      ended++;
    }
    return ended;
  }

  async function stalledRuns(t: Date) {
    const live = await db
      .select({ run: runs, agentName: agents.name, ticketTitle: tickets.title, ticketState: tickets.systemState, runnerId: runners.id })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(tickets, eq(tickets.id, runs.ticketId))
      .leftJoin(runners, eq(runners.companyId, runs.companyId))
      .where(isNull(runs.endedAt));
    const waiting = await waitingOnOwner();
    const stalled = new Map<string, (typeof live)[number] & { idle: number }>();
    for (const r of live) {
      // A finished ticket needs no alert about its run.
      if (waiting.has(r.run.id) || !r.runnerId || r.ticketState === "done") continue;
      const idle = t.getTime() - (r.run.lastEventAt ?? r.run.startedAt).getTime();
      if (idle >= limits.stallAfterMs) stalled.set(r.run.id, { ...r, idle });
    }

    const open = await openOfKind("stalled_run");
    await withdraw(open.filter((d) => !stalled.has((d.context as { runId: string }).runId)).map((d) => d.id));
    // An answered alert frees its key when the run stirred (a later stall is reported again), or,
    // after "Keep waiting", when the run is still quiet this long after the answer.
    const answered = await db
      .select({ id: decisions.id, context: decisions.context, answer: decisions.answer, answeredAt: decisions.answeredAt })
      .from(decisions)
      .where(and(eq(decisions.kind, "stalled_run"), eq(decisions.status, "answered"), isNotNull(decisions.dedupeKey)));
    const free = answered
      .filter((d) => !stalled.has((d.context as { runId: string }).runId) || (d.answer === KEEP_WAITING && d.answeredAt != null && t.getTime() - d.answeredAt.getTime() >= limits.keepWaitingMs))
      .map((d) => d.id);
    if (free.length) await db.update(decisions).set({ dedupeKey: null }).where(inArray(decisions.id, free));

    let raised = 0;
    for (const [runId, r] of stalled) {
      const ctx: DecisionContext = { type: "stalled_run", runnerId: r.runnerId!, runId };
      // The key stays after an answer, so "Keep waiting" silences this run for a while (see above).
      const rows = await db
        .insert(decisions)
        .values({
          companyId: r.run.companyId,
          kind: "stalled_run",
          // No event at all: the runner never began it, most likely lost in a runner restart.
          question: r.run.lastEventAt
            ? `${r.agentName ?? "An agent"} has sent nothing for ${ago(r.idle)}${r.ticketTitle ? ` while working on "${r.ticketTitle}"` : ""}. It may be stuck, or busy with a long command.`
            : `${r.agentName ?? "An agent"}'s run${r.ticketTitle ? ` on "${r.ticketTitle}"` : ""} never started: the runner hasn't reported it beginning in ${ago(r.idle)}, probably because the runner restarted. Cancel it, then message ${r.agentName ?? "the agent"} on the task to start again.`,
          options: [KEEP_WAITING, CANCEL_RUN],
          recommendedOption: r.run.lastEventAt ? KEEP_WAITING : CANCEL_RUN,
          raisedByAgentId: r.run.agentId,
          dedupeKey: `stalled:${runId}`,
          context: ctx,
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id });
      raised += rows.length;
    }
    return { open: stalled.size, raised };
  }

  /**
   * Assigned tickets that are ready to work on but that nothing is working on (R82): a wake was
   * lost, a runner was down, or the agent ended its run early. Tickets in review, plan-first
   * tickets awaiting approval, and unassigned tickets are left alone. An agent runs one ticket at
   * a time, so only idle agents are considered, and each is woken about one ticket per pass.
   */
  // An agent with a live run (chat aside) or any waiting wake is busy: its other tickets are just queued behind that.
  async function busyAgents() {
    return new Set([
      ...(await db.select({ id: runs.agentId }).from(runs).where(and(isNull(runs.endedAt), or(isNull(runs.purpose), sql`${runs.purpose} <> 'chat'`)))).map((r) => r.id),
      ...(await db.select({ id: wakes.agentId }).from(wakes).where(inArray(wakes.status, ["queued", "deferred"]))).map((w) => w.id),
    ]);
  }

  /** A review whose turn it is, with an idle reviewer and no verdict: wake the reviewer again, then tell the owner. */
  async function stalledReviews(t: Date) {
    const result = { woken: 0, gaveUp: 0 };
    const pending = await db
      .selectDistinct({ ticket: tickets })
      .from(reviewRequests)
      .innerJoin(tickets, eq(tickets.id, reviewRequests.ticketId))
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .where(and(eq(reviewRequests.status, "pending"), eq(tickets.systemState, "review"), eq(companies.paused, false), lte(reviewRequests.createdAt, new Date(t.getTime() - limits.missedAfterMs))));
    if (!pending.length) return result;
    const busy = await busyAgents();
    const done = new Set<string>();
    for (const { ticket } of pending) {
      for (const r of activeRows(await latestRows(db, ticket.id))) {
        const agentId = r.reviewerAgentId;
        if (!agentId || busy.has(agentId) || done.has(agentId)) continue;
        const [reviewer] = await db.select({ name: agents.name, paused: agents.paused, retiredAt: agents.retiredAt }).from(agents).where(eq(agents.id, agentId));
        if (!reviewer || reviewer.paused || reviewer.retiredAt) continue;
        // A run that ended after the request counts as the reviewer having looked; give it the usual quiet time.
        const [last] = await db.select({ at: max(runs.endedAt) }).from(runs).where(eq(runs.agentId, agentId));
        const lastActive = later(r.createdAt, last?.at)!;
        if (t.getTime() - lastActive.getTime() < limits.missedAfterMs) continue;
        // Review wakes name the ticket at the start of their note; the first one counts too.
        const recent = await db
          .select({ id: wakes.id, createdAt: wakes.createdAt })
          .from(wakes)
          .where(and(eq(wakes.agentId, agentId), eq(wakes.reason, REVIEW_REASON), like(wakes.note, `%- ${ticket.id} %`), gt(wakes.createdAt, new Date(t.getTime() - 86_400_000))))
          .orderBy(desc(wakes.createdAt));
        if (recent[0] && t.getTime() - recent[0].createdAt.getTime() < limits.missedAfterMs) continue;
        if (recent.length > MISSED_NUDGES_PER_DAY) {
          const rows = await db
            .insert(decisions)
            .values({
              companyId: ticket.companyId,
              kind: "question",
              question: `"${ticket.title}" is waiting for ${reviewer.name}'s ${r.kind} review. ${reviewer.name} was woken about it ${recent.length} times in the last day without giving a verdict. Look into it, or move the ticket on yourself.`,
              options: ["Got it"],
              recommendedOption: "Got it",
              dedupeKey: `review-stall:${r.id}`,
              context: { type: "question" },
            })
            .onConflictDoNothing()
            .returning({ id: decisions.id });
          result.gaveUp += rows.length;
          continue;
        }
        await opts.wake({
          agentId,
          reason: REVIEW_REASON,
          priority: 3,
          note: `- ${ticket.id} "${ticket.title}": still waiting for your ${r.kind} review (round ${r.round}), requested ${ago(t.getTime() - r.createdAt.getTime())} ago.\n  Read the changes with the review tool (action diff), then give your verdict with action submit.`,
        });
        done.add(agentId);
        result.woken++;
      }
    }
    return result;
  }

  async function missedWork(t: Date) {
    const msObjective = alias(objectives, "ms_objective");
    const rows = await db
      .select({ ticket: tickets, agent: agents.name, krPriority: objectives.priority, msPriority: msObjective.priority })
      .from(tickets)
      .innerJoin(agents, eq(agents.id, tickets.assigneeAgentId))
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .leftJoin(keyResults, eq(keyResults.id, tickets.keyResultId))
      .leftJoin(objectives, eq(objectives.id, keyResults.objectiveId))
      .leftJoin(milestones, eq(milestones.id, tickets.milestoneId))
      .leftJoin(msObjective, eq(msObjective.id, milestones.objectiveId))
      .where(
        and(
          inArray(tickets.systemState, ["ready", "in_progress"]),
          eq(agents.paused, false),
          isNull(agents.retiredAt),
          eq(companies.paused, false),
          or(eq(tickets.planFirst, false), isNotNull(tickets.planApprovedAt)),
          lte(tickets.lastActivityAt, new Date(t.getTime() - limits.missedAfterMs)),
          // Waiting on a scheduled check is a plan, not missed work.
          isNull(tickets.monitorAt),
          // A watched tree that has stopped is the watcher's to handle: it was woken about this exact state (watch_stopped_fp is cleared when the tree moves).
          sql`not exists (select 1 from tickets watch_root where watch_root.watch_stopped_fp is not null and watch_root.id in (${tickets.id}, ${tickets.parentTicketId}))`,
        ),
      );
    const busy = await busyAgents();
    // Most important objective first (a lower number is more important; no objective goes last), then idle longest.
    const rank = (c: (typeof rows)[number]) => Math.min(c.krPriority ?? 99, c.msPriority ?? 99);
    const candidates = rows.filter((c) => !busy.has(c.ticket.assigneeAgentId!)).sort((a, b) => rank(a) - rank(b) || a.ticket.lastActivityAt.getTime() - b.ticket.lastActivityAt.getTime());
    const result = { woken: 0, gaveUp: 0 };
    const done = new Set<string>();
    for (const { ticket, agent } of candidates) {
      const agentId = ticket.assigneeAgentId!;
      if (done.has(agentId)) continue;
      // Blocked the way decisions.ts decides it: any dependency not yet resolved.
      const deps = await db
        .select({ ticketState: tickets.systemState, engagementStatus: engagements.status, decisionStatus: decisions.status })
        .from(ticketDependencies)
        .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
        .leftJoin(engagements, eq(engagements.id, ticketDependencies.blockerEngagementId))
        .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
        .where(eq(ticketDependencies.blockedTicketId, ticket.id));
      if (deps.some((d) => (d.ticketState && d.ticketState !== "done") || (d.engagementStatus && d.engagementStatus !== "signed_off") || d.decisionStatus === "open")) continue;
      // Active means a run on this ticket that hasn't ended; the last run's end counts as activity.
      const ticketRuns = await db.select({ lastEventAt: runs.lastEventAt, endedAt: runs.endedAt }).from(runs).where(eq(runs.ticketId, ticket.id));
      if (ticketRuns.some((r) => !r.endedAt)) continue;
      const lastActive = ticketRuns.reduce<Date>((m, r) => later(later(m, r.lastEventAt), r.endedAt)!, ticket.lastActivityAt);
      if (t.getTime() - lastActive.getTime() < limits.missedAfterMs) continue;

      // Every wake counts, dropped ones too, so a dropped wake isn't retried every minute.
      const recent = await db
        .select({ id: wakes.id, createdAt: wakes.createdAt })
        .from(wakes)
        .where(and(eq(wakes.agentId, agentId), eq(wakes.ticketId, ticket.id), eq(wakes.reason, MISSED_REASON), gt(wakes.createdAt, new Date(t.getTime() - 86_400_000))))
        .orderBy(desc(wakes.createdAt));
      if (recent[0] && t.getTime() - recent[0].createdAt.getTime() < limits.missedEveryMs) continue;

      // The owner's note about this ticket holds off further wakes until it's answered.
      const [open] = await db.select({ id: decisions.id }).from(decisions).where(and(like(decisions.dedupeKey, `missed:${ticket.id}:%`), eq(decisions.status, "open"))).limit(1);
      if (open) continue;

      if (recent.length >= MISSED_NUDGES_PER_DAY) {
        // One decision per round of nudges: the key names the latest wake.
        const key = `missed:${ticket.id}:${recent[0]!.id}`;
        const rows = await db
          .insert(decisions)
          .values({
            companyId: ticket.companyId,
            kind: "question",
            question: `"${ticket.title}" looks stuck. ${agent} was woken about it ${recent.length} times in the last day and nothing is running on it; it was last active ${ago(t.getTime() - lastActive.getTime())} ago. Look into it, or reassign it.`,
            options: ["Got it"],
            recommendedOption: "Got it",
            dedupeKey: key,
            context: { type: "question" },
          })
          .onConflictDoNothing()
          .returning({ id: decisions.id });
        result.gaveUp += rows.length;
        continue;
      }
      await opts.wake({
        agentId,
        ticketId: ticket.id,
        reason: MISSED_REASON,
        note: `Nothing is running on this ticket, and it was last active at ${lastActive.toISOString().slice(0, 16).replace("T", " ")} UTC (${ago(t.getTime() - lastActive.getTime())} ago). Pick it up, or say why it's stuck.`,
      });
      done.add(agentId);
      result.woken++;
    }
    return result;
  }

  return {
    limits,
    /** One pass of every sweep. Safe to call often. */
    async run() {
      const t = now();
      await opts.endUnconfirmedCancels(t);
      const lost = await lostRuns(t);
      const staleB = await staleBlockers(t);
      const stalled = await stalledRuns(t);
      // While the update hold is on nothing can start, so an idle ticket is not forgotten work.
      const held = await getHold(db);
      const missed = held ? { woken: 0, gaveUp: 0 } : await missedWork(t);
      const reviews = held ? { woken: 0, gaveUp: 0 } : await stalledReviews(t);
      return { staleBlockers: staleB, stalledRuns: stalled, missedWork: missed, stalledReviews: reviews, lostRuns: lost };
    },
  };
}
