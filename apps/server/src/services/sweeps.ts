// Periodic sweeps that put forgotten work in front of the owner:
// - stale blockers (R21): a dependency whose blocker has had no activity for too long;
// - stalled runs (R32): a running agent that has gone quiet. Advisory only: nothing is cancelled
//   (but a run the runner has lost, or a cancel it never confirmed, is ended by the server);
// - missed work (R82): an assigned ticket that is ready to go but that nobody is working on;
// - stalled reviews: a review whose reviewer was woken but never gave a verdict.
// Rows that no longer apply are withdrawn, so the queue only shows live problems.
import { and, desc, eq, gt, inArray, isNotNull, isNull, like, lte, max, ne, or, sql } from "drizzle-orm";
import { MERGE_MISSED_AFTER_MS } from "@boss-man/shared";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, engagementMessages, engagements, keyResults, milestones, objectives, reviewRequests, runnerEvents, runners, runs, ticketDependencies, tickets, wakes } from "../db/schema.js";
import { record } from "./activity.js";
import { CANCEL_RUN, CHASE, DROP, KEEP_WAITING, LET_CEO_DECIDE, raiseMergeStuck, REASSIGN, type DecisionContext } from "./decisions.js";
import type { AlertInput } from "./alert-ladder.js";
import { raiseDueGoalChecks } from "./goal-check.js";
import { getHold } from "./maintenance.js";
import { activeRows, evaluate, latestRows } from "./review-kinds.js";
import { progressSweep } from "./progress.js";
import { MISSED_REASON, REVIEW_REASON, type WakeInput } from "./scheduler.js";

export type SweepLimits = {
  staleAfterMs: number;
  stallAfterMs: number;
  /** A ready, assigned ticket with no activity for this long counts as forgotten (R82). */
  missedAfterMs: number;
  /**
   * An approved ticket whose merge never finished is tried again after this long. It is longer than
   * the server's wait for a merge check, so a check that is still running is never mistaken for one
   * that stopped.
   */
  mergeMissedAfterMs: number;
  /** An agent is nudged about the same ticket at most once per this long (R82). */
  missedEveryMs: number;
  /** "Keep waiting" holds a stall alert off for this long; if the run is still quiet it is raised again. */
  keepWaitingMs: number;
  /** A run whose runner is offline (or never reported it) this long past the stall limit is ended by the server. */
  lostAfterMs: number;
  /** A run with no ticket after this long is flagged to the Scrum Master (BOS-254). */
  ticketlessAfterMs: number;
  /** While the run waits inside a long command (check-all, vitest, tsc), the stall alert waits this long instead (BOS-217). */
  busyStallAfterMs: number;
  /** A quiet run whose runner is connected and still answering pings is probably inside a long command: wait this long too (BOS-217). */
  busyRunnerAfterMs: number;
};
export const DEFAULT_SWEEP_LIMITS: SweepLimits = {
  staleAfterMs: 24 * 3_600_000,
  stallAfterMs: 5 * 60_000,
  missedAfterMs: 30 * 60_000,
  mergeMissedAfterMs: MERGE_MISSED_AFTER_MS,
  missedEveryMs: 4 * 3_600_000,
  keepWaitingMs: 30 * 60_000,
  lostAfterMs: 30 * 60_000,
  ticketlessAfterMs: 10 * 60_000,
  busyStallAfterMs: 15 * 60_000,
  busyRunnerAfterMs: 15 * 60_000,
};
// After this many nudges in a day the owner is told instead (R82).
const MISSED_NUDGES_PER_DAY = 2;

/** A clock time in plain words, e.g. "14:05" (UTC, like the rest of the server's notes). */
const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const ago = (ms: number) => (ms >= 2 * 86_400_000 ? `${Math.floor(ms / 86_400_000)} days` : ms >= 2 * 3_600_000 ? `${Math.floor(ms / 3_600_000)} hours` : `${Math.max(1, Math.floor(ms / 60_000))} minutes`);
const later = (a: Date | null | undefined, b: Date | null | undefined) => (!a ? (b ?? null) : !b || a > b ? a : b);

export function sweepService(db: Db, opts: { limits?: Partial<SweepLimits>; now?: () => Date; wake: (input: WakeInput) => Promise<unknown>; isConnected: (runnerId: string) => boolean; /** The runner connected only just now, so its queued runs are still starting (BOS-331). */ runnerSettling?: (runnerId: string) => boolean; endRun: (runId: string, outcome: string, at: Date) => Promise<unknown>; endUnconfirmedCancels: (t: Date) => Promise<unknown>; expireAdvice?: () => Promise<unknown>; retryLand?: (ticketId: string) => Promise<unknown>; /** True while a merge for the ticket is running and alive (BOS-362). */ landingActive?: (ticketId: string) => boolean; expireSkills?: () => Promise<unknown>; /** Raises a stalled run or review on the alert ladder (BOS-119). */ alert: (input: AlertInput) => Promise<{ id: string } | null> }) {
  const limits = { ...DEFAULT_SWEEP_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());

  async function withdraw(ids: string[]) {
    if (ids.length) await db.update(decisions).set({ status: "withdrawn", dedupeKey: null }).where(inArray(decisions.id, ids));
  }

  async function openOfKind(kind: "stale_blocker" | "stalled_run") {
    return db.select().from(decisions).where(and(eq(decisions.kind, kind), eq(decisions.status, "open")));
  }

  async function staleBlockers(t: Date) {
    // Only live dependencies: the blocked ticket isn't done and no decision stands in for the blocker.
    const deps = await db
      .select({ dep: ticketDependencies, blocked: tickets })
      .from(ticketDependencies)
      .innerJoin(tickets, eq(tickets.id, ticketDependencies.blockedTicketId))
      .where(and(ne(tickets.systemState, "done"), isNull(ticketDependencies.blockerDecisionId)));
    const stale = new Map<string, { question: string; options: string[]; recommended: string; companyId: string; ctx: DecisionContext }>();

    const ticketIds = [...new Set(deps.flatMap(({ dep }) => (dep.blockerTicketId ? [dep.blockerTicketId] : [])))];
    const engagementIds = [...new Set(deps.flatMap(({ dep }) => (!dep.blockerTicketId && dep.blockerEngagementId ? [dep.blockerEngagementId] : [])))];
    const blockers = new Map(
      (ticketIds.length ? await db.select({ t: tickets, assignee: agents.name }).from(tickets).leftJoin(agents, eq(agents.id, tickets.assigneeAgentId)).where(inArray(tickets.id, ticketIds)) : []).map((r) => [r.t.id, r] as const),
    );
    const blockerEngagements = new Map((engagementIds.length ? await db.select().from(engagements).where(inArray(engagements.id, engagementIds)) : []).map((e) => [e.id, e] as const));

    // A ticket counts as active if it moved recently or an agent is reporting on it.
    const runActivity = new Map(
      (ticketIds.length ? await db.select({ ticketId: runs.ticketId, at: max(runs.lastEventAt) }).from(runs).where(inArray(runs.ticketId, ticketIds)).groupBy(runs.ticketId) : []).flatMap((r) => (r.ticketId && r.at ? [[r.ticketId, r.at] as const] : [])),
    );
    const msgActivity = new Map(
      (engagementIds.length
        ? await db.select({ id: engagementMessages.engagementId, at: max(engagementMessages.createdAt) }).from(engagementMessages).where(inArray(engagementMessages.engagementId, engagementIds)).groupBy(engagementMessages.engagementId)
        : []
      ).map((r) => [r.id, r.at]),
    );

    for (const { dep, blocked } of deps) {
      const ctx: DecisionContext = { type: "stale_blocker", dependencyId: dep.id, blockedTicketId: blocked.id, blockerTicketId: dep.blockerTicketId, blockerEngagementId: dep.blockerEngagementId };
      if (dep.blockerTicketId) {
        const b = blockers.get(dep.blockerTicketId);
        if (!b || b.t.systemState === "done") continue;
        const idle = t.getTime() - later(b.t.lastActivityAt, runActivity.get(b.t.id))!.getTime();
        if (idle < limits.staleAfterMs) continue;
        const who = b.assignee ? `assigned to ${b.assignee}` : b.t.assignedToOwner ? "assigned to you" : "unassigned";
        stale.set(dep.id, {
          question: `"${b.t.title}" (${who}) has blocked "${blocked.title}" with no activity for ${ago(idle)}.`,
          options: [CHASE, REASSIGN, LET_CEO_DECIDE, DROP],
          // Nobody to chase means it needs an owner.
          recommended: b.t.assigneeAgentId || b.t.assignedToOwner ? CHASE : REASSIGN,
          companyId: blocked.companyId,
          ctx,
        });
      } else if (dep.blockerEngagementId) {
        const e = blockerEngagements.get(dep.blockerEngagementId);
        if (!e || e.status === "signed_off") continue;
        const idle = t.getTime() - later(e.createdAt, msgActivity.get(e.id))!.getTime();
        if (idle < limits.staleAfterMs) continue;
        stale.set(dep.id, {
          question: `The engagement "${e.title}" (${e.status.replace("_", " ")}) has blocked "${blocked.title}" with no activity for ${ago(idle)}.`,
          options: [CHASE, LET_CEO_DECIDE, DROP],
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

  /**
   * The last thing a run said, if it is still waiting inside a command (BOS-217): a check-all,
   * vitest or tsc that runs for ten minutes is work, not a run that has gone quiet. The runner
   * reports a tool call when it starts and again when it finishes; only a start counts.
   */
  async function busyInCommand(runId: string) {
    const [last] = await db
      .select({ type: runnerEvents.type, payload: runnerEvents.payload })
      .from(runnerEvents)
      .where(and(eq(runnerEvents.type, "run.update"), sql`${runnerEvents.payload}->>'runId' = ${runId}`))
      .orderBy(desc(runnerEvents.seq))
      .limit(1);
    if (!last) return null;
    const update = (last.payload as { update?: { kind?: unknown; title?: unknown; status?: unknown } } | null)?.update;
    if (!update || ((update.kind !== "tool_call" && update.kind !== "tool_call_update") || update.status !== "in_progress")) return null;
    return typeof update.title === "string" && update.title ? update.title.slice(0, 120) : "a command";
  }

  /**
   * The runs that count as stalled, alerts closed by themselves (BOS-217), and new alerts raised.
   * An alert about a run that has ended, or spoken again, is closed here with the reason, whether
   * it sat with the Scrum Master, the CEO or the owner.
   */
  async function stalledRuns(t: Date) {
    const live = await db
      .select({ run: runs, agentName: agents.name, ticketTitle: tickets.title, ticketState: tickets.systemState, runnerId: runners.id, runnerLastSeenAt: runners.lastSeenAt })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(tickets, eq(tickets.id, runs.ticketId))
      .leftJoin(runners, eq(runners.companyId, runs.companyId))
      .where(isNull(runs.endedAt));
    // Every run an open alert is about, ended or not: one that finished after its alert was raised
    // still needs the alert closed, and the live list below never holds it.
    const open = await openOfKind("stalled_run");
    const alertRuns = new Map<string, { endedAt: Date | null; lastEventAt: Date | null }>(live.map((r) => [r.run.id, { endedAt: null, lastEventAt: r.run.lastEventAt }]));
    const watched = [...new Set(open.map((d) => (d.context as { runId?: unknown }).runId).filter((id): id is string => typeof id === "string" && !alertRuns.has(id)))];
    if (watched.length) {
      for (const r of await db.select({ id: runs.id, endedAt: runs.endedAt, lastEventAt: runs.lastEventAt }).from(runs).where(inArray(runs.id, watched))) {
        alertRuns.set(r.id, { endedAt: r.endedAt, lastEventAt: r.lastEventAt });
      }
    }
    const waiting = await waitingOnOwner();
    const stalled = new Map<string, (typeof live)[number] & { idle: number }>();
    // Whether a run is stalled has to hold both when its alert is open and when one is about to be
    // raised, so an open alert is closed for the same reasons a new one would not be raised.
    const busy = new Map<string, string>();
    const idleOf = async (run: (typeof live)[number], withBusyChecks: boolean) => {
      const idle = t.getTime() - (run.run.lastEventAt ?? run.run.startedAt).getTime();
      // A finished ticket needs no alert about its run, and neither does one waiting on the owner.
      const eligible = !waiting.has(run.run.id) && !!run.runnerId && run.ticketState !== "done";
      if (!eligible || idle < limits.stallAfterMs) return { idle, stalled: false };
      // A run that has said nothing yet, on a runner that has only just come back, is queued behind the others: wait.
      if (!run.run.lastEventAt && opts.runnerSettling?.(run.runnerId!)) return { idle, stalled: false };
      if (!withBusyChecks) return { idle, stalled: true };
      const command = await busyInCommand(run.run.id);
      if (command) {
        busy.set(run.run.id, command);
        return { idle, stalled: idle >= limits.busyStallAfterMs };
      }
      // The runner answers Boss Man's pings every 15 seconds even mid-command. Events only arrive at
      // tool-call and turn boundaries, so a runner seen well after the last event is inside a long step.
      const lastSeen = run.runnerLastSeenAt?.getTime() ?? 0;
      if (lastSeen > (run.run.lastEventAt ?? run.run.startedAt).getTime() + limits.stallAfterMs) {
        busy.set(run.run.id, "a long command");
        return { idle, stalled: idle >= limits.busyRunnerAfterMs };
      }
      return { idle, stalled: true };
    };
    for (const r of live) {
      const v = await idleOf(r, true);
      if (v.stalled) stalled.set(r.run.id, { ...r, idle: v.idle });
    }

    // An alert about a run that has ended, or spoken since the alert was raised, is closed by itself
    // with the reason (BOS-217): the owner never sees one for a run that has moved on. One still
    // sitting inside a long command keeps its alert until the busy limit, as a new alert would.
    const closed = new Set<string>();
    for (const d of open) {
      const runId = (d.context as { runId?: unknown }).runId;
      if (typeof runId !== "string") continue;
      const row = alertRuns.get(runId);
      const liveRow = live.find((r) => r.run.id === runId);
      const spokeSince = !!row?.lastEventAt && row.lastEventAt.getTime() > d.createdAt.getTime();
      if (!row?.endedAt && !spokeSince && liveRow && (await idleOf(liveRow, true)).stalled) continue;
      const ended = row?.endedAt ?? null;
      const spokeAfterEnd = !!ended && (row?.lastEventAt?.getTime() ?? 0) > ended.getTime();
      const note = ended ? `the run ended normally at ${hhmm(ended)}${spokeAfterEnd ? ", then spoke again" : ""}` : "the run is active again";
      const [done] = await db
        .update(decisions)
        .set({ status: "withdrawn", answeredAt: t, dedupeKey: null, context: { ...(d.context as object), withdrawn: { by: "system", note, at: t.toISOString() } } })
        .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
        .returning({ id: decisions.id, question: decisions.question });
      if (!done) continue;
      closed.add(done.id);
      await record(db, { companyId: d.companyId, kind: "decision_withdrawn", summary: `Boss Man closed "${done.question.slice(0, 120)}" by itself: ${note}`, at: t });
    }
    await withdraw(open.filter((d) => !closed.has(d.id) && !stalled.has((d.context as { runId?: unknown }).runId as string)).map((d) => d.id));
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
      // A stalled run is the Scrum Master's first, then the CEO, then the owner (BOS-119). It goes
      // on the ladder whether or not the watchdog is switched on; without a Scrum Master it starts at the CEO.
      const row = opts.alert
        ? await opts.alert({
            companyId: r.run.companyId,
            kind: "stalled_run",
            // No event at all: the runner never began it, most likely lost in a runner restart.
            question: r.run.lastEventAt
              ? `${r.agentName ?? "An agent"} has sent nothing for ${ago(r.idle)}${r.ticketTitle ? ` while working on "${r.ticketTitle}"` : ""}. ${busy.get(runId) ? `It is still inside ${busy.get(runId)}, so it may just be a long command.` : "It may be stuck, or busy with a long command."}`
              : `${r.agentName ?? "An agent"}'s run${r.ticketTitle ? ` on "${r.ticketTitle}"` : ""} never started: the runner hasn't reported it beginning in ${ago(r.idle)}, probably because the runner restarted. Cancel it, then message ${r.agentName ?? "the agent"} on the task to start again.`,
            options: [KEEP_WAITING, CANCEL_RUN],
            recommended: r.run.lastEventAt ? KEEP_WAITING : CANCEL_RUN,
            from: "scrum_master",
            duty: true,
            ticketId: r.run.ticketId,
            about: [r.run.agentId],
            raisedByAgentId: r.run.agentId,
            dedupeKey: `stalled:${runId}`,
            context: ctx,
          })
        : null;
      if (row) raised++;
    }
    return { open: stalled.size, raised };
  }

  /**
   * A run that has been going this long with no ticket is flagged to the Scrum Master (BOS-254):
   * a run that found nothing to do should end, not sit there saying nothing useful for quarter of
   * an hour. The owner chat is not a ticketless run, and neither is a run that is only waiting on
   * a permission answer (it is the owner's, not a mystery).
   */
  async function longTicketlessRuns(t: Date) {
    const waiting = await waitingOnOwner();
    const live = await db
      .select({ run: runs, agentName: agents.name })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(and(isNull(runs.endedAt), isNull(runs.ticketId), sql`${runs.purpose} is distinct from 'chat'`));
    let raised = 0;
    for (const { run, agentName } of live) {
      if (waiting.has(run.id)) continue;
      if (t.getTime() - run.startedAt.getTime() < limits.ticketlessAfterMs) continue;
      // Say what it is really doing if it says anything at all; otherwise only how long it has run.
      const doing = run.lastEventAt ? `It last did something ${ago(t.getTime() - run.lastEventAt.getTime())} ago.` : "It hasn't reported anything since it started.";
      const row = await opts.alert({
        companyId: run.companyId,
        kind: "question",
        question: `${agentName ?? "An agent"} has been running for ${ago(t.getTime() - run.startedAt.getTime())} without a ticket ("${run.origin ?? run.purpose ?? "no reason recorded"}"). ${doing} Settle it: stop the run if there is nothing for it to do, or tell it on the ticket it should be on.`,
        options: ["Got it"],
        recommended: "Got it",
        from: "scrum_master",
        duty: true,
        about: [run.agentId],
        raisedByAgentId: run.agentId,
        dedupeKey: `ticketless:${run.id}`,
        context: { type: "question" },
      });
      if (row) raised++;
    }
    return { raised };
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
          // The CEO first: stopping or moving a review is beyond the Scrum Master, and the owner
          // should only see this if the CEO doesn't settle it (BOS-119).
          const row = await opts.alert({
            companyId: ticket.companyId,
            kind: "question",
            question: `"${ticket.title}" is waiting for ${reviewer.name}'s ${r.kind} review. ${reviewer.name} was woken about it ${recent.length} times in the last day without giving a verdict. Look into it, or move the ticket on yourself.`,
            options: ["Got it"],
            recommended: "Got it",
            from: "ceo",
            ticketId: ticket.id,
            about: [agentId],
            dedupeKey: `review-stall:${r.id}`,
            context: { type: "question" },
          });
          if (row) result.gaveUp++;
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

  // Tickets this server has already tried merging again, so each gets one automatic retry per server.
  // shortcut: lost on restart, harmless because a restarted server retrying once more is safe: a merge already done is found and closes the ticket.
  const retried = new Set<string>();

  /**
   * Tickets whose reviews all passed but that still sit in review: the merge never finished (the server
   * stopped mid-way, or a deploy handed over while the runner was merging). The merge is tried again once
   * by itself, which is safe (a branch already merged is found and the ticket closes); if that fails too,
   * the owner is asked to merge again or send back. One waiting on the owner's sign-off is left alone.
   */
  async function unmergedApprovals(t: Date) {
    const stuck = await db
      .select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId })
      .from(tickets)
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .where(and(eq(tickets.systemState, "review"), eq(companies.paused, false)));
    let raised = 0;
    for (const ticket of stuck) {
      const rows = await latestRows(db, ticket.id);
      if (!rows.length || evaluate(rows) !== "passed") continue;
      // Quiet is measured from the last approval, and a merge that is alive holds the sweep back. Chat, chases
      // and note refreshes on the ticket don't count: they used to postpone the retry for good (BOS-362).
      if (opts.landingActive?.(ticket.id)) continue;
      const approvedAt = Math.max(...rows.map((r) => (r.decidedAt ?? r.createdAt).getTime()));
      if (approvedAt > t.getTime() - limits.mergeMissedAfterMs) continue;
      const [signoff] = await db
        .select({ id: decisions.id })
        .from(ticketDependencies)
        .innerJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
        .where(and(eq(ticketDependencies.blockedTicketId, ticket.id), eq(decisions.status, "open")));
      if (signoff) continue;
      // Only an open card counts: an answered or withdrawn one must not stop the sweep (BOS-362).
      const [asked] = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.dedupeKey, `merge-stuck:${ticket.id}`), eq(decisions.status, "open")));
      if (asked) continue;
      if (opts.retryLand && !retried.has(ticket.id)) {
        retried.add(ticket.id);
        await opts.retryLand(ticket.id).catch(() => undefined);
        raised++;
        continue;
      }
      raised += (await raiseMergeStuck(db, ticket, "it was approved, then nothing merged it; the server may have restarted part-way")).length;
    }
    return raised;
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
      const goalChecks = await raiseDueGoalChecks(db, t);
      await opts.expireSkills?.();
      await opts.endUnconfirmedCancels(t);
      await opts.expireAdvice?.();
      const lost = await lostRuns(t);
      const staleB = await staleBlockers(t);
      const stalled = await stalledRuns(t);
      // While the update hold is on nothing can start, so an idle ticket is not forgotten work.
      const held = await getHold(db);
      const missed = held ? { woken: 0, gaveUp: 0 } : await missedWork(t);
      // Silent runs, reviews that end without a verdict, and causes left unproven (BOS-314): these run whether or not the watchdog is on.
      const progress = held ? { steered: 0, flagged: 0, reviewsMoved: 0, unproven: 0 } : await progressSweep(db, t, { wake: (input) => opts.wake(input as WakeInput), alert: opts.alert });
      const reviews = held ? { woken: 0, gaveUp: 0 } : await stalledReviews(t);
      const unmerged = held ? 0 : await unmergedApprovals(t);
      // A run with no ticket after ten minutes is the Scrum Master's to settle or stop (BOS-254).
      const ticketless = held ? { raised: 0 } : await longTicketlessRuns(t);
      return { goalChecks, staleBlockers: staleB, stalledRuns: stalled, missedWork: missed, stalledReviews: reviews, lostRuns: lost, unmergedApprovals: unmerged, longTicketlessRuns: ticketless, progress };
    },
  };
}

/**
 * Closes a run's stall alert the moment the run ends or speaks again (BOS-217), so it rarely sits
 * on the CEO's or the owner's queue until the next sweep. One line of why is recorded. Safe to
 * call for any event: an event that isn't about a run, or a run with no open alert, does nothing.
 */
export async function closeStallAlertForRun(db: Db, runId: string, now: () => Date = () => new Date()) {
  const [run] = await db.select({ endedAt: runs.endedAt, lastEventAt: runs.lastEventAt }).from(runs).where(eq(runs.id, runId));
  if (!run) return 0;
  const t = now();
  const open = await db
    .select({ id: decisions.id, companyId: decisions.companyId, question: decisions.question, context: decisions.context })
    .from(decisions)
    .where(and(eq(decisions.kind, "stalled_run"), eq(decisions.status, "open"), sql`${decisions.context}->>'runId' = ${runId}`));
  let closed = 0;
  for (const d of open) {
    const ended = run.endedAt;
    const note = ended ? `the run ended normally at ${hhmm(ended)}${run.lastEventAt && run.lastEventAt > ended ? ", then spoke again" : ""}` : "the run is active again";
    const [done] = await db
      .update(decisions)
      .set({ status: "withdrawn", answeredAt: t, dedupeKey: null, context: { ...(d.context as object), withdrawn: { by: "system", note, at: t.toISOString() } } })
      .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (!done) continue;
    closed++;
    await record(db, { companyId: d.companyId, kind: "decision_withdrawn", summary: `Boss Man closed "${d.question.slice(0, 120)}" by itself: ${note}`, at: t });
  }
  return closed;
}
