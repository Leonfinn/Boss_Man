// Periodic sweeps that put forgotten work in front of the owner:
// - stale blockers (R21): a dependency whose blocker has had no activity for too long;
// - stalled runs (R32): a running agent that has gone quiet. Advisory only: nothing is cancelled
//   (but a run the runner has lost, or a cancel it never confirmed, is ended by the server);
// - missed work (R82): an assigned ticket that is ready to go but that nobody is working on;
// - stalled reviews: a review whose reviewer was woken but never gave a verdict.
// Rows that no longer apply are withdrawn, so the queue only shows live problems.
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lte, max, ne, or, sql } from "drizzle-orm";
import { MERGE_MISSED_AFTER_MS, ticketRef } from "@boss-man/shared";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, engagementMessages, engagements, keyResults, milestones, notifications, objectives, reviewRequests, runnerEvents, runners, runs, ticketDependencies, tickets, wakes } from "../db/schema.js";
import { CANCEL_RUN, CHASE, DROP, KEEP_WAITING, LET_CEO_DECIDE, raiseMergeStuck, REASSIGN, REASSIGN_REVIEW, SEND_BACK_FOR_MERGE, TAKE_REVIEW, WAIT_ANOTHER_HOUR, type DecisionContext } from "./decisions.js";
import type { AlertInput } from "./alert-ladder.js";
import type { alertClearing } from "./alert-clearing.js";
import { raiseDueGoalChecks } from "./goal-check.js";
import { record } from "./activity.js";
import { checkPriority } from "./check-gate.js";
import { getHold } from "./maintenance.js";
import { sweepPhoneApprove } from "./approve-tokens.js";
import { activeRows, endedNormally, endedNormallySql, evaluate, latestRows, reviewAskPattern, reviewWaitedSince, roundStartedAt } from "./review-kinds.js";
import { derivedSignoff, sweepMissingSignoffs } from "./signoff.js";
import { progressSweep } from "./progress.js";
import { noProgressSweep } from "./no-progress.js";
import { CARRY_ON_NOTE, IDLE_AGENTS_REASON, IDLE_SLOT_REASON, MISSED_REASON, REVIEW_REASON, URGENT_IDLE_REASON, type WakeInput } from "./scheduler.js";

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
  /** An urgent ticket in progress whose assignee has no live or queued run is woken after this long idle (BOS-346). */
  urgentIdleAfterMs: number;
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
  /** A run inside scripts/check-quick.sh or check-all.sh may sit silent in the shared check queue; its alert waits this long (BOS-518). */
  checkQueueAfterMs: number;
  /** A run that has said nothing this long after launch, on a connected and settled runner, never began: it is started again (BOS-480). */
  neverStartedAfterMs: number;
  /** How many times a never-started run's wake is queued again before the CEO is told (BOS-480). */
  neverStartedRetries: number;
  /** An in-progress ticket quiet this long may be given a free run slot (BOS-574). Short, but long enough for a run's own carry-on or check to be set first. */
  idleFillAfterMs: number;
  /** One idle-slot wake per ticket per this long (BOS-574). */
  idleFillEveryMs: number;
  /** Idle-slot wakes per ticket in a day; after that the missed-work sweep and its "looks stuck" card take over (BOS-574). */
  idleFillsPerDay: number;
  /** Runs with no progress (no new commit, state change or review verdict) after which the "looks stuck" card recommends Reassign (BOS-612). */
  emptyRunsBeforeReassign: number;
  /** After a CEO plan's deadline the stuck card stays quiet this much longer (BOS-612). */
  planGraceMs: number;
  /** One "agents are idle, hand out work" wake to the CEO per company per this long (BOS-615). */
  idleAskEveryMs: number;
  /** More tickets than this in review and the CEO's idle-agents list puts no-code work first (BOS-615). */
  mergeLineLongAt: number;
  /** After a runner restart, how long its replayed "interrupted" reports get before a run it never reported is closed as lost (BOS-579). */
  restartReplayMs: number;
};
export const DEFAULT_SWEEP_LIMITS: SweepLimits = {
  staleAfterMs: 24 * 3_600_000,
  stallAfterMs: 5 * 60_000,
  missedAfterMs: 30 * 60_000,
  mergeMissedAfterMs: MERGE_MISSED_AFTER_MS,
  urgentIdleAfterMs: 2 * 60_000,
  missedEveryMs: 4 * 3_600_000,
  keepWaitingMs: 30 * 60_000,
  lostAfterMs: 30 * 60_000,
  ticketlessAfterMs: 10 * 60_000,
  busyStallAfterMs: 15 * 60_000,
  busyRunnerAfterMs: 15 * 60_000,
  checkQueueAfterMs: 2 * 3_600_000,
  neverStartedAfterMs: 3 * 60_000,
  neverStartedRetries: 2,
  idleFillAfterMs: 10 * 60_000,
  idleFillEveryMs: 60 * 60_000,
  idleFillsPerDay: 4,
  emptyRunsBeforeReassign: 3,
  planGraceMs: 30 * 60_000,
  idleAskEveryMs: 30 * 60_000,
  mergeLineLongAt: 10,
  restartReplayMs: 2 * 60_000,
};
/** How many unassigned tickets the CEO's idle-agents wake lists (BOS-615). */
const IDLE_ASK_TICKETS = 8;
/**
 * The line a re-queued wake carries at the end of its note: it is how the retries of one original
 * wake are counted without a column (BOS-480), and it tells the agent why it was started again.
 */
const RETRY_MARK = /\n*\[Boss Man started this again: the earlier start never began \(retry (\d+) of \d+\)\]$/;
// After this many nudges in a day the owner is told instead (R82).
const MISSED_NUDGES_PER_DAY = 2;
/** The wake that tells an author their branch no longer merges while a review waits (BOS-426). */
const CLASH_REASON = "review clash";

/** A clock time in plain words, e.g. "14:05" (UTC, like the rest of the server's notes). */
const hhmm = (d: Date) => d.toISOString().slice(11, 16);
/** A command that is the repo check script, which waits silently for the one-slot check lock (BOS-518). */
const CHECK_SCRIPT = /(?:^|[\s/"';&|(])scripts\/check-(?:quick|all)\.sh(?![\w.-])/;
/** The same, as a Postgres regular expression over a stored command or title (BOS-574). */
const CHECK_SCRIPT_SQL = "scripts/check-(quick|all)\\.sh";
/**
 * A run that ended by itself (BOS-574): not cut off (those get a resume wake), not stopped or
 * cancelled by someone, and not failed (the loop guards and missed work handle failures).
 */
const endedByItself = (outcome: string | null) => !!outcome && endedNormally(outcome) && outcome !== "cancelled" && !outcome.startsWith("stopped") && !outcome.startsWith("error");
const ago = (ms: number) => (ms >= 2 * 86_400_000 ? `${Math.floor(ms / 86_400_000)} days` : ms >= 2 * 3_600_000 ? `${Math.floor(ms / 3_600_000)} hours` : `${Math.max(1, Math.floor(ms / 60_000))} minutes`);
const later = (a: Date | null | undefined, b: Date | null | undefined) => (!a ? (b ?? null) : !b || a > b ? a : b);

export function sweepService(db: Db, opts: { limits?: Partial<SweepLimits>; now?: () => Date; wake: (input: WakeInput) => Promise<unknown>; /** Closes every card whose conditions have cleared (DR-016, BOS-470). */ clearAlerts?: () => Promise<number>; /** Raises the CEO card for each roadmap feature with no open ticket (BOS-595); without it that sweep does nothing. */ featuresWithoutTickets?: () => Promise<number>; isConnected: (runnerId: string) => boolean; /** The runner connected only just now, so its queued runs are still starting (BOS-331). */ runnerSettling?: (runnerId: string) => boolean; /** When the runner's current process was seen to start after a restart, if it was (BOS-579). */ runnerRestartedAt?: (runnerId: string) => Date | null; endRun: (runId: string, outcome: string, at: Date, how?: { interrupted?: boolean }) => Promise<unknown>; /** How many more work runs the company could start now (BOS-574); without it the idle-slot sweep does nothing. */ freeSlots?: (companyId: string) => Promise<number>; /** Queues a wake as given, never merged into another or steered into a live run (BOS-480). */ requeue?: (input: WakeInput) => Promise<unknown>; /** Tells the runner to drop a run it may still be setting up. */ cancelOnRunner?: (runnerId: string, runId: string) => unknown; endUnconfirmedCancels: (t: Date) => Promise<unknown>; expireAdvice?: () => Promise<unknown>; retryLand?: (ticketId: string) => Promise<unknown>; /** Starts an approved merge again when a server takes charge (DR-026). */ resumeLand?: (ticketId: string) => Promise<unknown>; /** Releases a backlog or blocked ticket whose blockers are all done (BOS-603); true if it did something. */ releaseUnblocked?: (ticketId: string) => Promise<boolean>; /** True while a merge for the ticket is running and alive (BOS-362). */ landingActive?: (ticketId: string) => boolean; /** The files the ticket's branch would clash with on the default branch; null when that can't be told (BOS-426). */ branchClash?: (ticketId: string) => Promise<string[] | null>; expireSkills?: () => Promise<unknown>; /** Raises a stalled run or review on the alert ladder (BOS-119). */ alert: (input: AlertInput) => Promise<{ id: string } | null>; /** The owner's unanswered ticket messages (BOS-425): the 5-minute re-wake and the 10-minute stand-in. */ ownerReplies?: (t: Date) => Promise<{ rewoken: number; standIns: number }>; /** The head commit of a ticket's branch on its runner, for telling a run that committed from one that did not (BOS-612). Throws or returns null when it can't be read. */ branchHead?: (ticketId: string) => Promise<string | null> }) {
  const limits = { ...DEFAULT_SWEEP_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());

  async function withdraw(ids: string[]) {
    if (!ids.length) return;
    await db.update(decisions).set({ status: "withdrawn", dedupeKey: null }).where(inArray(decisions.id, ids));
    // Withdrawn without an answer: their notifications are read now (BOS-413).
    await db.update(notifications).set({ readAt: now() }).where(and(inArray(notifications.decisionId, ids), isNull(notifications.readAt)));
  }

  /** Tells the company's CEO once, as a ticketless decision wake (one per raised card). */
  async function tellCeo(companyId: string, note: string) {
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (ceo) await opts.wake({ agentId: ceo.id, ticketId: null, reason: "decision", note });
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
   * A run on a connected runner that has sent anything is left alone, however long its command,
   * unless that runner has restarted since the run began (BOS-579): the new process has none of the
   * old one's runs, and reports those it knew of as interrupted straight after it connects. Any run
   * still open once that replay has had `restartReplayMs` is one it never knew of, and it is closed
   * as lost so it stops holding its agent's and company's run limits.
   */
  async function lostRuns(t: Date) {
    const live = await db
      .select({ run: runs, runnerId: runners.id, bootId: runners.bootId })
      .from(runs)
      .leftJoin(runners, eq(runners.companyId, runs.companyId))
      .where(isNull(runs.endedAt));
    const waiting = await waitingOnOwner();
    let ended = 0;
    for (const r of live) {
      const restarted = r.runnerId ? opts.runnerRestartedAt?.(r.runnerId) : null;
      if (restarted && r.run.lastEventAt && r.run.startedAt < restarted && t.getTime() - restarted.getTime() >= limits.restartReplayMs) {
        // Cut off by the restart: resumed like a run the runner reports as interrupted (BOS-574).
        await opts.endRun(r.run.id, "lost: runner restarted", t, { interrupted: true });
        ended++;
        continue;
      }
      if (waiting.has(r.run.id)) continue;
      const idle = t.getTime() - (r.run.lastEventAt ?? r.run.startedAt).getTime();
      if (idle < limits.stallAfterMs + limits.lostAfterMs) continue;
      if (r.runnerId && opts.isConnected(r.runnerId) && r.run.lastEventAt) continue;
      // Cut off, not stopped by anyone: it is resumed like a run the runner reports as interrupted (BOS-574).
      if (r.run.lastEventAt) await opts.endRun(r.run.id, "lost: runner offline", t, { interrupted: true });
      // Never started (the runner was offline throughout, say): its wake is queued again, to start once the runner is back.
      else await endNeverStarted(r.run, r.runnerId, r.bootId, t);
      ended++;
    }
    return ended;
  }

  /**
   * Whether the runner said the run is waiting for the repo lock (BOS-331). Such a run is alive
   * but sends no event of its own until the lock frees, up to 30 minutes, so it is not lost.
   */
  async function waitingForRepoLock(runId: string) {
    const [hit] = await db
      .select({ id: runnerEvents.id })
      .from(runnerEvents)
      .where(and(eq(runnerEvents.type, "runner.log"), sql`${runnerEvents.payload}->>'message' like ${`Run ${runId} is waiting for the repo lock%`}`))
      .limit(1);
    return !!hit;
  }

  /**
   * Runs the runner never began (BOS-480): `run.started` sets `lastEventAt`, so a run without one,
   * this long after launch on a runner that is connected and past its settling time, was lost (most
   * often in a runner restart). It is ended and its wake queued again; nobody is asked to cancel it.
   */
  async function neverStartedRuns(t: Date) {
    const live = await db
      .select({ run: runs, runnerId: runners.id, bootId: runners.bootId })
      .from(runs)
      .innerJoin(runners, eq(runners.companyId, runs.companyId))
      // A run being cancelled is left to the cancel sweep, which ends it within a minute.
      .where(and(isNull(runs.endedAt), isNull(runs.lastEventAt), isNull(runs.cancelRequestedAt)));
    let ended = 0;
    for (const r of live) {
      if (t.getTime() - r.run.startedAt.getTime() < limits.neverStartedAfterMs) continue;
      if (!opts.isConnected(r.runnerId) || opts.runnerSettling?.(r.runnerId)) continue;
      if (await waitingForRepoLock(r.run.id)) continue;
      if (await endNeverStarted(r.run, r.runnerId, r.bootId, t)) ended++;
    }
    return ended;
  }

  /**
   * Ends a run that never started and queues its wake again: same agent, ticket, reason, note and
   * priority, keeping the run it resumes, with no cause (a retry is not a new link in a chain).
   * After `neverStartedRetries` retries of one wake, the CEO is told instead (BOS-480).
   */
  async function endNeverStarted(run: typeof runs.$inferSelect, runnerId: string | null, bootId: string | null, t: Date) {
    if ((await opts.endRun(run.id, "lost: never started", t)) === false) return false;
    // The runner may still be setting the run up (slow, not lost): stop it there, so the retry can't
    // end up running beside it. A runner that doesn't know the run just reports it ended.
    if (runnerId && opts.isConnected(runnerId)) opts.cancelOnRunner?.(runnerId, run.id);
    const [w] = await db.select().from(wakes).where(eq(wakes.runId, run.id)).limit(1);
    // A deploy's run is not retried: its deploy failed when the run ended, and only a new approval restarts it.
    if (!w || w.deployId || !opts.requeue) return true;
    const tries = Number(w.note?.match(RETRY_MARK)?.[1] ?? 0);
    if (tries >= limits.neverStartedRetries) {
      await tellCeoNeverStarted(run.companyId, w, runnerId, bootId);
      return true;
    }
    const note = (w.note ?? "").replace(RETRY_MARK, "");
    const mark = `[Boss Man started this again: the earlier start never began (retry ${tries + 1} of ${limits.neverStartedRetries})]`;
    await opts.requeue({ agentId: w.agentId, ticketId: w.ticketId, reason: w.reason, note: note ? `${note}\n\n${mark}` : mark, priority: w.priority, resumeRunId: w.resumeRunId, causedByRunId: null });
    return true;
  }

  /**
   * One CEO card per runner boot lists every agent whose run never started even after its retries
   * (BOS-480, DR-017 D). A later failure on the same boot is added to the open card, not a new one.
   */
  async function tellCeoNeverStarted(companyId: string, w: typeof wakes.$inferSelect, runnerId: string | null, bootId: string | null) {
    const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, w.agentId));
    const [ticket] = w.ticketId ? await db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, w.ticketId)) : [];
    const entry = `${agent?.name ?? "An agent"}${ticket ? ` on "${ticket.title}"` : ""}`;
    const question = (list: string[]) =>
      `${list.length === 1 ? "A run" : `${list.length} runs`} never started on the runner, even after Boss Man started ${list.length === 1 ? "it" : "each"} again ${limits.neverStartedRetries} times: ${list.join("; ")}. Boss Man has stopped trying. Check the runner (Settings → Server and runner), then wake ${list.length === 1 ? "the agent" : "these agents"} again.`;
    const dedupeKey = `runner-boot:${runnerId ?? "none"}:${bootId ?? "unknown"}`;
    // The CEO is this card's highest rung (DR-017 A): the `runner_boot` kind's row holds it there (BOS-469).
    // No `cause`, so the ladder doesn't fold it into its generic "N runs" heading: this card keeps its own
    // list of agents and tickets in the question, added to below under the same dedupe key.
    // No `about` or ticket: it lists several agents, and an agent it is about (the CEO itself) would be skipped as a rung.
    const raised = await opts.alert({ companyId, kind: "runner_boot", question: question([entry]), from: "ceo", dedupeKey, context: { neverStarted: [entry] } });
    if (raised) return;
    const [open] = await db.select().from(decisions).where(and(eq(decisions.dedupeKey, dedupeKey), eq(decisions.status, "open")));
    if (!open) return;
    const list = (open.context as { neverStarted?: string[] }).neverStarted ?? [];
    if (list.includes(entry)) return;
    const next = [...list, entry];
    await db
      .update(decisions)
      .set({ question: question(next), context: { ...(open.context as object), neverStarted: next } })
      .where(and(eq(decisions.id, open.id), eq(decisions.status, "open")));
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
    const update = (last.payload as { update?: { kind?: unknown; title?: unknown; status?: unknown; rawInput?: unknown } } | null)?.update;
    if (!update || ((update.kind !== "tool_call" && update.kind !== "tool_call_update") || update.status !== "in_progress")) return null;
    const raw = (update as { rawInput?: { command?: unknown } }).rawInput?.command;
    const title = typeof update.title === "string" && update.title ? update.title.slice(0, 120) : "a command";
    return { title, checkScript: CHECK_SCRIPT.test(typeof raw === "string" ? raw : "") || CHECK_SCRIPT.test(typeof update.title === "string" ? update.title : "") };
  }

  /**
   * The runs that count as stalled, and new alerts raised. An alert about a run that has ended, or
   * spoken again, is closed by the one closer (DR-016, BOS-470) on its `runActive` condition, whether
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
    const open = await openOfKind("stalled_run");
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
      // A run that has never said anything is not stalled but not started: the never-started sweep
      // retries it, and nobody is asked to cancel it (BOS-480).
      if (!run.run.lastEventAt) return { idle, stalled: false };
      if (!withBusyChecks) return { idle, stalled: true };
      const command = await busyInCommand(run.run.id);
      if (command) {
        busy.set(run.run.id, command.title);
        // A check script waits silently for the shared check slot; the queue can be long, so it gets the longer limit (BOS-518).
        return { idle, stalled: idle >= (command.checkScript ? limits.checkQueueAfterMs : limits.busyStallAfterMs) };
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

    // An alert about a run that has ended, or spoken since the alert was raised, is closed by the
    // one closer on its `runActive` condition (DR-016, BOS-470), so the owner never sees one for a
    // run that has moved on. One still sitting inside a long command keeps its alert until the busy
    // limit, as a new alert would. A card with no condition at all (an older one) is closed here as before.
    const untyped = open.filter((d) => !(d.context as { clearWhen?: unknown }).clearWhen);
    await withdraw(untyped.filter((d) => !stalled.has((d.context as { runId?: unknown }).runId as string)).map((d) => d.id));
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

    // One open alert per run: a card already with the team (on any rung) is not raised again, whichever key it uses.
    const alreadyOpen = new Set(open.map((d) => (d.context as { runId?: unknown }).runId).filter((id): id is string => typeof id === "string"));
    let raised = 0;
    for (const [runId, r] of stalled) {
      if (alreadyOpen.has(runId)) continue;
      const ctx: DecisionContext = { type: "stalled_run", runnerId: r.runnerId!, runId };
      // A stalled run is the Scrum Master's first, then the CEO, then the owner (BOS-119). It goes
      // on the ladder whether or not the watchdog is switched on; without a Scrum Master it starts at the CEO.
      const row = opts.alert
        ? await opts.alert({
            companyId: r.run.companyId,
            cardKind: "stalled_run",
            kind: "stalled_run",
            cause: { runId },
            question: `${r.agentName ?? "An agent"} has sent nothing for ${ago(r.idle)}${r.ticketTitle ? ` while working on "${r.ticketTitle}"` : ""}. ${busy.get(runId) ? `It is still inside ${busy.get(runId)}, so it may just be a long command.` : "It may be stuck, or busy with a long command."}`,
            options: [KEEP_WAITING, CANCEL_RUN],
            recommended: KEEP_WAITING,
            from: "scrum_master",
            duty: true,
            ticketId: r.run.ticketId,
            about: [r.run.agentId],
            raisedByAgentId: r.run.agentId,
            dedupeKey: `stalled:${runId}`,
            context: ctx,
            // The run stirring or its ticket finishing closes it (DR-016; the ticketDone row saves waiting for the run to end).
            clearWhen: [{ kind: "runActive", runId }, ...(r.run.ticketId ? [{ kind: "ticketDone" as const, ticketId: r.run.ticketId }] : [])],
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
        kind: "ticketless_run",
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
  const clashAskedAt = new Map<string, number>(); // review id -> when the runner was last asked about a clash (BOS-426)
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
        // A run that ended after the request counts as the reviewer having looked; give it the usual
        // quiet time. A run that was cut off (interrupted, or lost by the server) never gave a verdict,
        // so it must not hold the re-wake back (DR-017, decision F).
        const roundStart = (await roundStartedAt(db, ticket.id)) ?? r.createdAt;
        const [last] = await db.select({ at: max(runs.endedAt) }).from(runs).where(and(eq(runs.agentId, agentId), endedNormallySql(runs.outcome)));
        const lastActive = later(roundStart, last?.at)!;
        if (t.getTime() - lastActive.getTime() < limits.missedAfterMs) continue;
        // "Leave it another hour" holds this review for another quiet period, starting from the answer,
        // so the CEO's choice isn't re-asked within a minute (BOS-426, BOS-433 fix B).
        const waited = await reviewWaitedSince(db, r.id);
        if (waited && t.getTime() - waited.getTime() < limits.missedAfterMs) continue;
        // A branch that no longer merges is a reason a reviewer sits idle (BOS-426): wake the author to merge
        // main, not the reviewer again, and don't count it as a missed review. The review stays open and resumes.
        // Review wakes name the ticket at the start of their note; the first one counts too. Only this
        // round's wakes count (BOS-433): a reviewer who answered rounds 1-2 isn't reported for round 3.
        const recent = await db
          .select({ id: wakes.id, createdAt: wakes.createdAt })
          .from(wakes)
          .where(and(eq(wakes.agentId, agentId), eq(wakes.reason, REVIEW_REASON), like(wakes.note, reviewAskPattern(ticket.id)), gte(wakes.createdAt, roundStart)))
          .orderBy(desc(wakes.createdAt));
        if (recent[0] && t.getTime() - recent[0].createdAt.getTime() < limits.missedAfterMs) continue;
        // The runner is only asked when a wake would go out: at most once per missedAfterMs per review, since
        // each answer costs a fetch under the project's repo lock. A check that can't answer (null) changes nothing.
        if (ticket.assigneeAgentId && opts.branchClash) {
          const [lastAsk] = await db
            .select({ createdAt: wakes.createdAt })
            .from(wakes)
            .where(and(eq(wakes.agentId, ticket.assigneeAgentId), eq(wakes.reason, CLASH_REASON), eq(wakes.ticketId, ticket.id)))
            .orderBy(desc(wakes.createdAt))
            .limit(1);
          if (lastAsk && t.getTime() - lastAsk.createdAt.getTime() < limits.missedAfterMs) {
            // The author was just told to merge main; leave the reviewer alone meanwhile.
            done.add(agentId);
            continue;
          }
          // Asked recently (clean, unknown or clash alike)? Don't ask again: the give-up path below wakes nobody,
          // so without this a stuck review would cost a fetch every sweep. Lost on restart, which is harmless.
          const askedAt = clashAskedAt.get(r.id);
          const clash = askedAt !== undefined && t.getTime() - askedAt < limits.missedAfterMs ? null : (clashAskedAt.set(r.id, t.getTime()), await opts.branchClash(ticket.id));
          if (clash) {
            await opts.wake({
              agentId: ticket.assigneeAgentId,
              ticketId: ticket.id,
              reason: CLASH_REASON,
              priority: 3,
              note: `- ${ticket.id} "${ticket.title}": the ${r.kind} review is waiting, but your branch no longer merges with the default branch${clash.length ? ` (clashes in: ${clash.slice(0, 10).join(", ")})` : ""}. Merge origin's default branch into your branch, resolve the conflicts keeping both sides' intent, run the checks, commit, then move the ticket to review again. The review resumes from there.`,
            });
            done.add(agentId);
            continue;
          }
        }
        if (recent.length > MISSED_NUDGES_PER_DAY) {
          // The CEO first: stopping or moving a review is beyond the Scrum Master, and the owner
          // should only see this if the CEO doesn't settle it (BOS-119). Real actions on the review,
          // not "Got it": the CEO can take it over, give it to another reviewer, send it back to the
          // author, or leave it another hour (BOS-404, BOS-426, BOS-433 fix B kept its card).
          const row = await opts.alert({
            companyId: ticket.companyId,
            kind: "review_stall",
            question: `"${ticket.title}" is waiting for ${reviewer.name}'s ${r.kind} review. ${reviewer.name} was woken about it this round ${recent.length} times without giving a verdict. What should happen to the review?`,
            options: [TAKE_REVIEW, REASSIGN_REVIEW, SEND_BACK_FOR_MERGE, WAIT_ANOTHER_HOUR],
            recommended: WAIT_ANOTHER_HOUR,
            from: "ceo",
            ticketId: ticket.id,
            about: [agentId],
            dedupeKey: `review-stall:${r.id}`,
            context: { type: "review_stall", reviewId: r.id, ticketId: ticket.id, reviewerAgentId: agentId, kind: r.kind },
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
  /**
   * Approved tickets still in review whose merge isn't running: reviews all passed, no open sign-off, no open
   * merge-stuck card, company not paused, no live merge in this process. Oldest wait is not judged here.
   */
  async function approvedUnmerged() {
    const stuck = await db
      .select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId, urgent: tickets.urgent, refusal: tickets.pullRequestNote })
      .from(tickets)
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .where(and(eq(tickets.systemState, "review"), eq(companies.paused, false)));
    const out: Array<(typeof stuck)[number] & { approvedAt: number }> = [];
    for (const ticket of stuck) {
      const rows = await latestRows(db, ticket.id);
      if (!rows.length || evaluate(rows) !== "passed") continue;
      // A merge that is alive holds the sweep back. Chat, chases and note refreshes on the ticket don't count (BOS-362).
      if (opts.landingActive?.(ticket.id)) continue;
      const [signoff] = await db
        .select({ id: decisions.id })
        .from(ticketDependencies)
        .innerJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
        .where(and(eq(ticketDependencies.blockedTicketId, ticket.id), eq(decisions.status, "open")));
      if (signoff) continue;
      // Owed the owner's sign-off, card or not: never retried as a merge; the sign-off sweep raises a lost card (BOS-503, DR-021).
      const [full] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
      if (!full) continue;
      const so = (await derivedSignoff(db, full)).state;
      if (so !== "not_needed" && so !== "signed_off") continue;
      // Only an open card counts: an answered or withdrawn one must not stop the sweep (BOS-362).
      const [asked] = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.dedupeKey, `merge-stuck:${ticket.id}`), eq(decisions.status, "open")));
      if (asked) continue;
      out.push({ ...ticket, approvedAt: Math.max(...rows.map((r) => (r.decidedAt ?? r.createdAt).getTime())) });
    }
    return out;
  }

  /**
   * A server has just taken charge (DR-026): it holds no merges, so every approved, unmerged ticket whose last
   * approval came before it took charge is started again now, urgent and arch fixes first. Returns how many
   * started and how many must wait (update hold on, or the company's runner not connected yet): the caller
   * asks again until none wait.
   */
  async function resumeMergesOnPromotion(promotedAt: Date) {
    if (!opts.resumeLand) return { started: 0, waiting: 0 };
    if (await getHold(db)) return { started: 0, waiting: 1 };
    const list = (await approvedUnmerged()).filter((x) => x.approvedAt < promotedAt.getTime());
    list.sort((a, b) => checkPriority(a) - checkPriority(b) || a.approvedAt - b.approvedAt);
    let started = 0;
    let waiting = 0;
    for (const ticket of list) {
      const companyRunners = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, ticket.companyId));
      if (!companyRunners.some((r) => opts.isConnected(r.id))) {
        waiting++;
        continue;
      }
      const ok = await opts.resumeLand(ticket.id).then(() => true, () => false);
      if (!ok) continue;
      started++;
      await record(db, { companyId: ticket.companyId, ticketId: ticket.id, kind: "merge_check_lock_wait", summary: "The server restarted during this merge, so it was started again. Nothing to do." });
    }
    return { started, waiting };
  }

  async function unmergedApprovals(t: Date) {
    let raised = 0;
    for (const ticket of await approvedUnmerged()) {
      // Quiet is measured from the last approval (BOS-362).
      if (ticket.approvedAt > t.getTime() - limits.mergeMissedAfterMs) continue;
      if (opts.retryLand && !retried.has(ticket.id)) {
        retried.add(ticket.id);
        await opts.retryLand(ticket.id).catch(() => undefined);
        raised++;
        continue;
      }
      // A stored refusal (BOS-684, the carried-work gate) is the reason; otherwise the merge simply never finished.
      // Either way the CEO can answer "Run the check again" on the card.
      const why = ticket.refusal ? `the merge was refused and the sweep's one retry is used up: ${ticket.refusal.replace(/\.$/, "")}` : "it was approved, then nothing merged it; the server may have restarted part-way";
      raised += (await raiseMergeStuck(db, ticket, why)).length;
    }
    return raised;
  }

  /**
   * How many runs the assignee has started on the ticket since it last made progress (BOS-612). Progress is a new
   * commit on the branch, a state change or a review verdict. A run start and a state-note edit are not. Null when
   * a commit can't be ruled out (the branch head could not be read), so the caller does not escalate on a guess.
   */
  async function emptyRuns(ticket: typeof tickets.$inferSelect, t: Date): Promise<number | null> {
    let progressAt = ticket.progressAt;
    let known = !ticket.branch;
    if (ticket.branch && opts.branchHead) {
      const head = await opts.branchHead(ticket.id).catch(() => null);
      if (head) {
        known = true;
        if (head !== ticket.progressHead) {
          // A first sighting at the base commit is no commit; any other change is a commit we saw just now.
          if (ticket.progressHead || head !== ticket.baseCommit) progressAt = t;
          await db.update(tickets).set({ progressHead: head, progressAt }).where(eq(tickets.id, ticket.id));
        }
      }
    }
    if (!known) return null;
    const [verdict] = await db.select({ at: max(reviewRequests.decidedAt) }).from(reviewRequests).where(eq(reviewRequests.ticketId, ticket.id));
    const since = [ticket.stateChangedAt, verdict?.at, progressAt].reduce<Date>((m, d) => (d && d > m ? d : m), new Date(0));
    const started = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.ticketId, ticket.id), ticket.assigneeAgentId ? eq(runs.agentId, ticket.assigneeAgentId) : undefined, gt(runs.startedAt, since)));
    return started.length;
  }

  /**
   * Backlog or blocked tickets whose blockers are all resolved but were never released (BOS-603: BOS-290 sat
   * two days). Also the one-off catch-up after deploy: a released ticket is ready, so it never matches again.
   */
  async function releaseUnblocked() {
    const result = { released: 0 };
    if (!opts.releaseUnblocked) return result;
    const rows = await db
      .select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId })
      .from(tickets)
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .where(and(inArray(tickets.systemState, ["backlog", "blocked"]), eq(companies.paused, false), sql`exists (select 1 from ticket_dependencies td where td.blocked_ticket_id = ${tickets.id})`, sql`not exists (select 1 from ticket_dependencies td join tickets b on b.id = td.blocker_ticket_id where td.blocked_ticket_id = ${tickets.id} and b.system_state <> 'done')`,
        // Only if the last blocker finished after the ticket last changed state: a ticket put back in backlog on purpose stays there.
        sql`(select max(b.state_changed_at) from ticket_dependencies td join tickets b on b.id = td.blocker_ticket_id where td.blocked_ticket_id = ${tickets.id}) > ${tickets.stateChangedAt}`));
    const byCompany = new Map<string, string[]>();
    for (const { id, title, companyId } of rows) {
      if (await isBlocked(id)) continue;
      if (!(await opts.releaseUnblocked(id))) continue;
      result.released++;
      byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), title]);
    }
    // One summary for the CEO the first time the catch-up releases anything, so a ticket held on purpose can be put back.
    for (const [companyId, titles] of byCompany) {
      await db
        .insert(decisions)
        .values({
          companyId,
          kind: "question",
          question: `Tickets that were waiting on finished work have been started: ${titles.map((x) => `"${x}"`).join(", ")}. If any was held on purpose, move it back to backlog; it stays there.`,
          options: ["Got it"],
          recommendedOption: "Got it",
          dedupeKey: `unblocked-catchup:${companyId}`,
          context: { type: "question" },
        })
        .onConflictDoNothing();
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

      // A CEO plan with a deadline holds the card until the deadline plus a grace; after that one card says it passed (BOS-612).
      const planAt = ticket.ceoPlanDeadline;
      if (planAt && t.getTime() < planAt.getTime() + limits.planGraceMs && recent.length >= MISSED_NUDGES_PER_DAY) continue;
      if (planAt && t.getTime() >= planAt.getTime() + limits.planGraceMs && !ticket.ceoPlanAlertedAt && recent.length >= MISSED_NUDGES_PER_DAY) {
        const rows = await db
          .insert(decisions)
          .values({
            companyId: ticket.companyId,
            kind: "question",
            question: `The plan for "${ticket.title}" had a deadline of ${planAt.toISOString().slice(0, 16).replace("T", " ")} UTC and it has passed with nothing moving. ${agent} was woken about it ${recent.length} times in the last day and nothing is running on it. The plan was: ${(ticket.ceoPlan ?? "").slice(0, 300)}`,
            options: [REASSIGN, "Got it"],
            recommendedOption: REASSIGN,
            dedupeKey: `missed:${ticket.id}:plan:${planAt.getTime()}`,
            context: { type: "question" },
          })
          .onConflictDoNothing()
          .returning({ id: decisions.id });
        await db.update(tickets).set({ ceoPlanAlertedAt: t }).where(eq(tickets.id, ticket.id));
        result.gaveUp += rows.length;
        continue;
      }
      if (recent.length >= MISSED_NUDGES_PER_DAY) {
        // One decision per round of nudges: the key names the latest wake.
        const key = `missed:${ticket.id}:${recent[0]!.id}`;
        // An answered card keeps its key, so the insert below would do nothing: skip the runner lookup too (it is a whole-branch diff).
        const [already] = await db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.companyId, ticket.companyId), eq(decisions.dedupeKey, key))).limit(1);
        if (already) continue;
        // Runs that moved nothing: no new commit, state change or review verdict since the last progress (BOS-612).
        const empty = await emptyRuns(ticket, t);
        const reassign = empty !== null && empty >= limits.emptyRunsBeforeReassign;
        const rows = await db
          .insert(decisions)
          .values({
            companyId: ticket.companyId,
            kind: "question",
            question: `"${ticket.title}" looks stuck. ${agent} was woken about it ${recent.length} times in the last day and nothing is running on it; it was last active ${ago(t.getTime() - lastActive.getTime())} ago.${reassign ? ` ${agent} has run on it ${empty} times with no new commit, state change or review, so reassign it (assign_ticket).` : " Look into it, or reassign it."}`,
            options: reassign ? [REASSIGN, "Got it"] : ["Got it"],
            recommendedOption: reassign ? REASSIGN : "Got it",
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

  /**
   * An urgent ticket in progress whose assignee has no live or queued run (BOS-346): wake them now,
   * not after the half hour missedWork waits. Scheduled by Boss Man, one wake per ticket at a time.
   */
  async function urgentIdle(t: Date) {
    const rows = await db
      .select({ ticket: tickets })
      .from(tickets)
      .innerJoin(agents, eq(agents.id, tickets.assigneeAgentId))
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .where(
        and(
          eq(tickets.urgent, true),
          eq(tickets.systemState, "in_progress"),
          eq(agents.paused, false),
          isNull(agents.retiredAt),
          eq(companies.paused, false),
          or(eq(tickets.planFirst, false), isNotNull(tickets.planApprovedAt)),
          lte(tickets.lastActivityAt, new Date(t.getTime() - limits.urgentIdleAfterMs)),
          isNull(tickets.monitorAt),
        ),
      )
      .orderBy(asc(tickets.lastActivityAt));
    const busy = await busyAgents();
    const result = { woken: 0 };
    for (const { ticket } of rows) {
      const agentId = ticket.assigneeAgentId!;
      if (busy.has(agentId)) continue;
      const deps = await db
        .select({ ticketState: tickets.systemState, engagementStatus: engagements.status, decisionStatus: decisions.status })
        .from(ticketDependencies)
        .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
        .leftJoin(engagements, eq(engagements.id, ticketDependencies.blockerEngagementId))
        .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
        .where(eq(ticketDependencies.blockedTicketId, ticket.id));
      if (deps.some((d) => (d.ticketState && d.ticketState !== "done") || (d.engagementStatus && d.engagementStatus !== "signed_off") || d.decisionStatus === "open")) continue;
      const ticketRuns = await db.select({ lastEventAt: runs.lastEventAt, endedAt: runs.endedAt }).from(runs).where(eq(runs.ticketId, ticket.id));
      if (ticketRuns.some((r) => !r.endedAt)) continue;
      const lastActive = ticketRuns.reduce<Date>((m, r) => later(later(m, r.lastEventAt), r.endedAt)!, ticket.lastActivityAt);
      if (t.getTime() - lastActive.getTime() < limits.urgentIdleAfterMs) continue;
      // One wake per ticket: a recent one (dropped ones too) holds off the next, so a refusal isn't retried every minute.
      const [recent] = await db
        .select({ id: wakes.id })
        .from(wakes)
        .where(and(eq(wakes.ticketId, ticket.id), eq(wakes.reason, URGENT_IDLE_REASON), gt(wakes.createdAt, new Date(t.getTime() - limits.missedEveryMs))))
        .limit(1);
      if (recent) continue;
      await opts.wake({
        agentId,
        ticketId: ticket.id,
        reason: URGENT_IDLE_REASON,
        priority: 2,
        note: `This ticket is urgent and nothing is running on it (last active ${ago(t.getTime() - lastActive.getTime())} ago). Pick it up now, or say why it's stuck.`,
      });
      busy.add(agentId);
      result.woken++;
    }
    return result;
  }

  /** Whether the ticket still waits on something unfinished, the way decisions.ts decides it. */
  async function isBlocked(ticketId: string) {
    const deps = await db
      .select({ ticketState: tickets.systemState, engagementStatus: engagements.status, decisionStatus: decisions.status })
      .from(ticketDependencies)
      .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
      .leftJoin(engagements, eq(engagements.id, ticketDependencies.blockerEngagementId))
      .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
      .where(eq(ticketDependencies.blockedTicketId, ticketId));
    return deps.some((d) => (d.ticketState && d.ticketState !== "done") || (d.engagementStatus && d.engagementStatus !== "signed_off") || d.decisionStatus === "open");
  }

  /** Whether the run started or waited on scripts/check-quick.sh or check-all.sh: its agent is in the shared check line (BOS-574). */
  async function ranCheckScript(runId: string) {
    const [hit] = await db
      .select({ id: runnerEvents.id })
      .from(runnerEvents)
      .where(
        and(
          eq(runnerEvents.type, "run.update"),
          sql`${runnerEvents.payload}->>'runId' = ${runId}`,
          sql`(coalesce(${runnerEvents.payload}->'update'->'rawInput'->>'command', '') ~ ${CHECK_SCRIPT_SQL} or coalesce(${runnerEvents.payload}->'update'->>'title', '') ~ ${CHECK_SCRIPT_SQL})`,
        ),
      )
      .limit(1);
    return !!hit;
  }

  /**
   * Free run slots go to in-progress work nobody is running (BOS-574, DR-029). A ticket qualifies when
   * its assignee is idle (no live run, no waiting wake), it has no booked check, isn't blocked or held
   * for a plan, has been quiet `idleFillAfterMs`, and its last run ended by itself. A ticket whose last
   * run used the check scripts is waiting in the check line and is left alone: waking it only buys a
   * "still queued" run (DR-027). Urgent first, then the more important objective, then the longest idle;
   * one ticket per agent and no more than the company's free slots per pass; each ticket at most once
   * per `idleFillEveryMs` and `idleFillsPerDay` times a day, at the lowest priority.
   */
  async function idleSlots(t: Date) {
    const result = { woken: 0 };
    if (!opts.freeSlots) return result;
    const msObjective = alias(objectives, "ms_objective");
    const rows = await db
      .select({ ticket: tickets, krPriority: objectives.priority, msPriority: msObjective.priority })
      .from(tickets)
      .innerJoin(agents, eq(agents.id, tickets.assigneeAgentId))
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .leftJoin(keyResults, eq(keyResults.id, tickets.keyResultId))
      .leftJoin(objectives, eq(objectives.id, keyResults.objectiveId))
      .leftJoin(milestones, eq(milestones.id, tickets.milestoneId))
      .leftJoin(msObjective, eq(msObjective.id, milestones.objectiveId))
      .where(
        and(
          eq(tickets.systemState, "in_progress"),
          eq(agents.paused, false),
          isNull(agents.retiredAt),
          eq(companies.paused, false),
          or(eq(tickets.planFirst, false), isNotNull(tickets.planApprovedAt)),
          lte(tickets.lastActivityAt, new Date(t.getTime() - limits.idleFillAfterMs)),
          // A booked check is a plan (DR-027): that agent is woken when it is due.
          isNull(tickets.monitorAt),
          sql`not exists (select 1 from tickets watch_root where watch_root.watch_stopped_fp is not null and watch_root.id in (${tickets.id}, ${tickets.parentTicketId}))`,
        ),
      );
    const busy = await busyAgents();
    const rank = (c: (typeof rows)[number]) => Math.min(c.krPriority ?? 99, c.msPriority ?? 99);
    const candidates = rows
      .filter((c) => !busy.has(c.ticket.assigneeAgentId!))
      .sort((a, b) => Number(b.ticket.urgent) - Number(a.ticket.urgent) || rank(a) - rank(b) || a.ticket.lastActivityAt.getTime() - b.ticket.lastActivityAt.getTime());
    const room = new Map<string, number>();
    for (const { ticket } of candidates) {
      const agentId = ticket.assigneeAgentId!;
      if (busy.has(agentId)) continue;
      if (!room.has(ticket.companyId)) room.set(ticket.companyId, await opts.freeSlots(ticket.companyId));
      if ((room.get(ticket.companyId) ?? 0) <= 0) continue;
      if (await isBlocked(ticket.id)) continue;
      const [live] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.ticketId, ticket.id), isNull(runs.endedAt))).limit(1);
      if (live) continue;
      const [last] = await db
        .select({ id: runs.id, outcome: runs.outcome, lastEventAt: runs.lastEventAt, endedAt: runs.endedAt })
        .from(runs)
        .where(and(eq(runs.ticketId, ticket.id), eq(runs.agentId, agentId)))
        .orderBy(desc(runs.startedAt))
        .limit(1);
      const lastActive = later(later(ticket.lastActivityAt, last?.lastEventAt), last?.endedAt)!;
      if (t.getTime() - lastActive.getTime() < limits.idleFillAfterMs) continue;
      if (last) {
        if (!endedByItself(last.outcome)) continue;
        if (t.getTime() - lastActive.getTime() < limits.checkQueueAfterMs && (await ranCheckScript(last.id))) continue;
      }
      // Dropped wakes count too, so a refused one isn't tried again every minute.
      const recent = await db
        .select({ createdAt: wakes.createdAt })
        .from(wakes)
        .where(and(eq(wakes.ticketId, ticket.id), eq(wakes.reason, IDLE_SLOT_REASON), gt(wakes.createdAt, new Date(t.getTime() - 86_400_000))))
        .orderBy(desc(wakes.createdAt));
      if (recent[0] && t.getTime() - recent[0].createdAt.getTime() < limits.idleFillEveryMs) continue;
      if (recent.length >= limits.idleFillsPerDay) continue;
      await opts.wake({
        agentId,
        ticketId: ticket.id,
        reason: IDLE_SLOT_REASON,
        priority: 1,
        note: `A run slot is free and this ticket is in progress with nothing running and no check booked (last active ${ago(t.getTime() - lastActive.getTime())} ago, at ${hhmm(lastActive)} UTC). Carry on with it. If you are waiting on something (a check, a review, a person), call schedule_check for when to look again, so Boss Man doesn't wake you before then; if it's finished, move it on.`,
      });
      busy.add(agentId);
      room.set(ticket.companyId, (room.get(ticket.companyId) ?? 0) - 1);
      result.woken++;
    }
    const roomIn = async (companyId: string) => {
      if (!room.has(companyId)) room.set(companyId, await opts.freeSlots!(companyId));
      return room.get(companyId) ?? 0;
    };
    const ready = await readySlots(t, busy, roomIn, (companyId) => room.set(companyId, (room.get(companyId) ?? 0) - 1));
    const asked = await askCeoForWork(t, busy, roomIn);
    return { ...result, ready, asked };
  }

  /**
   * Tier 2 of the idle-slot sweep (BOS-615): an idle agent's assigned `ready` ticket is its next up (the CEO
   * or PM puts the plan's next ticket there), so a free slot starts it at once rather than after missed
   * work's half hour. Agents with in-progress work that isn't waiting on a booked check are left to tier 1
   * and missed work, so a ready ticket never pulls an agent off what it was doing. Same order, quiet time and
   * per-ticket limits as tier 1; blocked tickets and plan-first ones awaiting approval are skipped, and so is a
   * ticket missed work has already nudged today (its own ladder ends in the "looks stuck" card).
   */
  async function readySlots(t: Date, busy: Set<string | null>, roomIn: (companyId: string) => Promise<number>, take: (companyId: string) => void) {
    const msObjective = alias(objectives, "ms_objective");
    const rows = await db
      .select({ ticket: tickets, krPriority: objectives.priority, msPriority: msObjective.priority })
      .from(tickets)
      .innerJoin(agents, eq(agents.id, tickets.assigneeAgentId))
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .leftJoin(keyResults, eq(keyResults.id, tickets.keyResultId))
      .leftJoin(objectives, eq(objectives.id, keyResults.objectiveId))
      .leftJoin(milestones, eq(milestones.id, tickets.milestoneId))
      .leftJoin(msObjective, eq(msObjective.id, milestones.objectiveId))
      .where(
        and(
          eq(tickets.systemState, "ready"),
          eq(agents.paused, false),
          isNull(agents.retiredAt),
          eq(companies.paused, false),
          // Plan-first tickets wait for their plan's approval, as in missed work.
          or(eq(tickets.planFirst, false), isNotNull(tickets.planApprovedAt)),
          // Quiet as long as tier 1 asks, so a ticket just assigned (its "assigned" wake) or just handed back isn't doubled.
          lte(tickets.lastActivityAt, new Date(t.getTime() - limits.idleFillAfterMs)),
          isNull(tickets.monitorAt),
          sql`not exists (select 1 from tickets watch_root where watch_root.watch_stopped_fp is not null and watch_root.id in (${tickets.id}, ${tickets.parentTicketId}))`,
          sql`not exists (select 1 from tickets doing where doing.assignee_agent_id = ${tickets.assigneeAgentId} and doing.system_state = 'in_progress' and doing.monitor_at is null)`,
        ),
      );
    const rank = (c: (typeof rows)[number]) => Math.min(c.krPriority ?? 99, c.msPriority ?? 99);
    const candidates = rows
      .filter((c) => !busy.has(c.ticket.assigneeAgentId!))
      .sort((a, b) => Number(b.ticket.urgent) - Number(a.ticket.urgent) || rank(a) - rank(b) || a.ticket.createdAt.getTime() - b.ticket.createdAt.getTime());
    let woken = 0;
    for (const { ticket } of candidates) {
      const agentId = ticket.assigneeAgentId!;
      if (busy.has(agentId)) continue;
      if ((await roomIn(ticket.companyId)) <= 0) continue;
      if (await isBlocked(ticket.id)) continue;
      const ticketRuns = await db.select({ lastEventAt: runs.lastEventAt, endedAt: runs.endedAt }).from(runs).where(eq(runs.ticketId, ticket.id));
      if (ticketRuns.some((r) => !r.endedAt)) continue;
      const lastActive = ticketRuns.reduce<Date>((m, r) => later(later(m, r.lastEventAt), r.endedAt)!, ticket.lastActivityAt);
      if (t.getTime() - lastActive.getTime() < limits.idleFillAfterMs) continue;
      const recent = await db
        .select({ createdAt: wakes.createdAt, reason: wakes.reason })
        .from(wakes)
        .where(and(eq(wakes.ticketId, ticket.id), inArray(wakes.reason, [IDLE_SLOT_REASON, MISSED_REASON]), gt(wakes.createdAt, new Date(t.getTime() - 86_400_000))))
        .orderBy(desc(wakes.createdAt));
      // Once missed work has nudged this ticket, its ladder (two wakes, then "looks stuck") owns it; more wakes here would only hold that card back.
      if (recent.some((w) => w.reason === MISSED_REASON)) continue;
      if (recent[0] && t.getTime() - recent[0].createdAt.getTime() < limits.idleFillEveryMs) continue;
      if (recent.length >= limits.idleFillsPerDay) continue;
      await opts.wake({
        agentId,
        ticketId: ticket.id,
        reason: IDLE_SLOT_REASON,
        priority: 1,
        note: `A run slot is free and you have nothing else running, so start this ticket: it is assigned to you and ready, which makes it your next up. If it can't start yet (it waits on something, or isn't yours to do), say why on the ticket and move it back to backlog or blocked, so Boss Man doesn't offer it again.`,
      });
      busy.add(agentId);
      take(ticket.companyId);
      woken++;
    }
    return woken;
  }

  /**
   * Tier 3 of the idle-slot sweep (BOS-615): slots are still free, and some agents have nothing to do (idle,
   * no ready or in-progress ticket, no review they owe; the stalled-review sweep handles reviewers). The
   * server doesn't pick unassigned work itself, as the fit (role, plan first, risk) is the CEO's call, so the
   * CEO gets one batched wake listing the idle agents and the top unassigned tickets. At most one per
   * company per `idleAskEveryMs`, and none while the same agents and tickets were already listed within
   * `missedEveryMs`, so an agent the CEO leaves idle on purpose doesn't start a CEO run every half hour.
   */
  async function askCeoForWork(t: Date, busy: Set<string | null>, roomIn: (companyId: string) => Promise<number>) {
    const idle = await db
      .select({ id: agents.id, companyId: agents.companyId, name: agents.name, title: agents.title, role: agents.role })
      .from(agents)
      .innerJoin(companies, eq(companies.id, agents.companyId))
      .where(
        and(
          ne(agents.role, "ceo"),
          eq(agents.paused, false),
          isNull(agents.retiredAt),
          eq(companies.paused, false),
          sql`not exists (select 1 from tickets mine where mine.assignee_agent_id = ${agents.id} and mine.system_state in ('ready', 'in_progress'))`,
          sql`not exists (select 1 from review_requests owed join tickets reviewed on reviewed.id = owed.ticket_id where owed.reviewer_agent_id = ${agents.id} and owed.status = 'pending' and reviewed.system_state = 'review')`,
        ),
      )
      .orderBy(asc(agents.name));
    const byCompany = new Map<string, typeof idle>();
    for (const a of idle) if (!busy.has(a.id)) byCompany.set(a.companyId, [...(byCompany.get(a.companyId) ?? []), a]);
    let asked = 0;
    for (const [companyId, people] of byCompany) {
      const free = await roomIn(companyId);
      if (free <= 0) continue;
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), eq(agents.paused, false), isNull(agents.retiredAt)));
      if (!ceo) continue;
      const lastAsks = await db
        .select({ note: wakes.note, createdAt: wakes.createdAt })
        .from(wakes)
        .where(and(eq(wakes.companyId, companyId), eq(wakes.reason, IDLE_AGENTS_REASON), gt(wakes.createdAt, new Date(t.getTime() - limits.missedEveryMs))))
        .orderBy(desc(wakes.createdAt))
        .limit(1);
      if (lastAsks[0] && t.getTime() - lastAsks[0].createdAt.getTime() < limits.idleAskEveryMs) continue;
      const msObjective = alias(objectives, "ms_objective");
      const open = await db
        .select({ ticket: tickets, prefix: companies.ticketPrefix, krPriority: objectives.priority, msPriority: msObjective.priority })
        .from(tickets)
        .innerJoin(companies, eq(companies.id, tickets.companyId))
        .leftJoin(keyResults, eq(keyResults.id, tickets.keyResultId))
        .leftJoin(objectives, eq(objectives.id, keyResults.objectiveId))
        .leftJoin(milestones, eq(milestones.id, tickets.milestoneId))
        .leftJoin(msObjective, eq(msObjective.id, milestones.objectiveId))
        .where(and(eq(tickets.companyId, companyId), inArray(tickets.systemState, ["backlog", "ready"]), isNull(tickets.assigneeAgentId)));
      if (!open.length) continue;
      // While the merge line is long, work that needs no check slot (no-code: research, wiki, docs) goes first.
      const [{ waiting } = { waiting: 0 }] = await db.select({ waiting: sql<number>`count(*)::int` }).from(tickets).where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "review")));
      const lineLong = waiting > limits.mergeLineLongAt;
      const rank = (c: (typeof open)[number]) => Math.min(c.krPriority ?? 99, c.msPriority ?? 99);
      open.sort(
        (a, b) =>
          (lineLong ? Number(b.ticket.noCode) - Number(a.ticket.noCode) : 0) ||
          Number(b.ticket.urgent) - Number(a.ticket.urgent) ||
          rank(a) - rank(b) ||
          Number(b.ticket.systemState === "ready") - Number(a.ticket.systemState === "ready") ||
          a.ticket.createdAt.getTime() - b.ticket.createdAt.getTime(),
      );
      const top: string[] = [];
      for (const { ticket, prefix } of open) {
        if (top.length >= IDLE_ASK_TICKETS) break;
        if (await isBlocked(ticket.id)) continue;
        const marks = [ticket.systemState, ticket.urgent ? "urgent" : null, ticket.noCode ? "no code, needs no check slot" : null, ticket.planFirst ? "plan first" : null, ticket.risk ? `${ticket.risk} risk` : null].filter(Boolean).join(", ");
        top.push(`- ${ticketRef(prefix, ticket.number) ?? ticket.id} "${ticket.title}" (${marks})`);
      }
      if (!top.length) continue;
      // The lists, without the slot count that changes every pass: the same lists already asked about aren't asked again.
      const body = [
        `Idle agents (no live run, no ready or in-progress ticket, no review owed):`,
        ...people.map((p) => `- ${p.name} (${p.title ?? p.role})`),
        ``,
        `Unassigned tickets, most important first${lineLong ? ` (no-code first: ${waiting} tickets wait to merge)` : ""}:`,
        ...top,
        ``,
        `Give an idle agent its next ticket with assign_ticket and move it to ready; Boss Man then starts it in a free slot. Match the role, keep plan-first and risky work for agents who can carry it, and leave an agent idle if nothing fits. You are asked again only when this list changes.`,
      ].join("\n");
      if (lastAsks[0]?.note?.endsWith(`\n${body}`)) continue;
      await opts.wake({ agentId: ceo.id, reason: IDLE_AGENTS_REASON, priority: 1, note: `${free} run slot${free === 1 ? " is" : "s are"} free and ${people.length === 1 ? "an agent has" : `${people.length} agents have`} nothing to work on.\n${body}` });
      asked++;
    }
    return asked;
  }

  /**
   * An update's hold has lifted (BOS-574). Every agent was told to end its turn and that it would be
   * woken once the update was done (WRAP_UP); this keeps that promise. Each in-progress ticket whose
   * assignee's run ended by itself after the hold began is woken on that ticket, with why. A ticket
   * with a check its agent booked keeps it (a runner restart brings it forward already); Boss Man's own
   * 15-minute carry-on is replaced by this wake. Blocked tickets, and tickets with a run or a wake
   * already, are left alone. Runs cut off by the update already have their resume wake.
   */
  async function resumeAfterUpdate(since: Date) {
    const ended = await db
      .select({ run: runs, ticket: tickets })
      .from(runs)
      .innerJoin(tickets, eq(tickets.id, runs.ticketId))
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .innerJoin(companies, eq(companies.id, runs.companyId))
      .where(
        and(
          gte(runs.endedAt, since),
          sql`${runs.purpose} is distinct from 'chat'`,
          eq(tickets.systemState, "in_progress"),
          eq(tickets.assigneeAgentId, runs.agentId),
          eq(agents.paused, false),
          isNull(agents.retiredAt),
          eq(companies.paused, false),
        ),
      )
      .orderBy(desc(runs.endedAt));
    const seen = new Set<string>();
    let woken = 0;
    for (const { run, ticket } of ended) {
      // The newest run on each ticket decides.
      if (seen.has(ticket.id)) continue;
      seen.add(ticket.id);
      if (!endedByItself(run.outcome)) continue;
      if (ticket.monitorAt && ticket.monitorNote !== CARRY_ON_NOTE) continue;
      if (await isBlocked(ticket.id)) continue;
      const [live] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.ticketId, ticket.id), isNull(runs.endedAt))).limit(1);
      if (live) continue;
      const [queued] = await db
        .select({ id: wakes.id })
        .from(wakes)
        .where(and(eq(wakes.agentId, run.agentId!), eq(wakes.ticketId, ticket.id), inArray(wakes.status, ["queued", "deferred"])))
        .limit(1);
      if (queued) continue;
      if (ticket.monitorAt) await db.update(tickets).set({ monitorAt: null, monitorNote: null }).where(and(eq(tickets.id, ticket.id), eq(tickets.monitorNote, CARRY_ON_NOTE)));
      await opts.wake({
        agentId: run.agentId!,
        ticketId: ticket.id,
        reason: "resume",
        priority: 2,
        note: `Your last run on this ticket ended at ${hhmm(run.endedAt!)} UTC because a runner update asked every agent to stop. The update is done, so carry on where you stopped: check the ticket and your branch first, and rerun any background check you had going (a runner restart ends it). If you are waiting on something, call schedule_check for when to look again.`,
      });
      woken++;
    }
    return { woken };
  }

  // A whole company with work waiting and nothing finishing (BOS-593). Its cause test asks whether a live run waits in the check line.
  const noProgress = noProgressSweep(db, { alert: opts.alert, isConnected: opts.isConnected, inCheckLine: async (runId) => !!(await busyInCommand(runId))?.checkScript });
  // `run` is a property so a test can stand in for one sweep step and watch the pass around it (BOS-611).
  type Pass = { goalChecks: { raised: number }; closedCards: number | undefined; featuresWithoutTickets: number; staleBlockers: Awaited<ReturnType<typeof staleBlockers>>; stalledRuns: Awaited<ReturnType<typeof stalledRuns>>; urgentIdle: { woken: number }; missedWork: { woken: number; gaveUp: number }; releasedUnblocked: { released: number }; idleSlots: { woken: number }; stalledReviews: { woken: number; gaveUp: number }; neverStartedRuns: number; lostRuns: number; unmergedApprovals: number; signoffCards: Awaited<ReturnType<typeof sweepMissingSignoffs>>; longTicketlessRuns: { raised: number }; ownerReplies: { rewoken: number; standIns: number }; noProgress: { raised: number }; progress: { steered: number; flagged: number; reviewsMoved: number; unproven: number }; phoneApprove: Awaited<ReturnType<typeof sweepPhoneApprove>> };

  return {
    limits,
    resumeMergesOnPromotion,
    resumeAfterUpdate,
    /** One pass of every sweep. Safe to call often. */
    run: async (_noProgressRun: (t: Date) => Promise<{ raised: number }> = (t) => noProgress.run(t)): Promise<Pass> => {
      const t = now();
      const goalChecks = await raiseDueGoalChecks(db, t);
      await opts.expireSkills?.();
      await opts.endUnconfirmedCancels(t);
      await opts.expireAdvice?.();
      // Phone Approve links and tap records are kept a day (BOS-243 rule 8).
      const phoneApprove = await sweepPhoneApprove(db, t);
      const neverStarted = await neverStartedRuns(t);
      const lost = await lostRuns(t);
      const staleB = await staleBlockers(t);
      const stalled = await stalledRuns(t);
      // While the update hold is on nothing can start, so an idle ticket is not forgotten work.
      const held = await getHold(db);
      // Cards whose cause has gone close themselves here (DR-016, BOS-470), on any tier: a limit that
      // has reset, an agent that has run cleanly since, a ticket that has finished.
      const closedCards = await opts.clearAlerts?.();
      const urgentIdleResult = held ? { woken: 0 } : await urgentIdle(t);
      const releasedResult = held ? { released: 0 } : await releaseUnblocked();
      const missed = held ? { woken: 0, gaveUp: 0 } : await missedWork(t);
      // After missed work, so its wakes already count against the free slots (BOS-574).
      const idleSlotsResult = held ? { woken: 0 } : await idleSlots(t);
      // Silent runs, reviews that end without a verdict, and causes left unproven (BOS-314): these run whether or not the watchdog is on.
      const progress = held ? { steered: 0, flagged: 0, reviewsMoved: 0, unproven: 0 } : await progressSweep(db, t, { wake: (input) => opts.wake(input as WakeInput), alert: opts.alert, inCheckQueue: async (runId, silentMs) => silentMs < limits.checkQueueAfterMs && !!(await busyInCommand(runId))?.checkScript });
      const reviews = held ? { woken: 0, gaveUp: 0 } : await stalledReviews(t);
      // A ticket that waits on the owner's sign-off always has its card (BOS-503): raised before the merge
      // sweep, so a lost card is put back rather than the ticket being merged or forgotten. Runs while held too:
      // it only raises a card, it starts no work.
      const signoffCards = await sweepMissingSignoffs(db, tellCeo);
      const unmerged = held ? 0 : await unmergedApprovals(t);
      // A run with no ticket after ten minutes is the Scrum Master's to settle or stop (BOS-254).
      const ticketless = held ? { raised: 0 } : await longTicketlessRuns(t);
      // The owner's messages that nobody has answered (BOS-425). A hold stops new runs, so both
      // steps wait, like the other sweeps: an ask to the CEO would start a run too.
      const unanswered = held ? { rewoken: 0, standIns: 0 } : opts.ownerReplies ? await opts.ownerReplies(t).catch(() => ({ rewoken: 0, standIns: 0 })) : { rewoken: 0, standIns: 0 };
      // After the closer, so a company that has just moved again isn't raised. An update hold stops every
      // company on purpose, so it isn't a stall. A failing query here must not take the whole sweep down
      // every minute (BOS-611), as with the owner replies above.
      const noProgressResult = held ? { raised: 0 } : await _noProgressRun(t).catch(() => ({ raised: 0 }));
      // A feature the roadmap commits to with nothing working on it (BOS-595): the CEO is asked to give
      // it a ticket. Raised after the closer, so a feature whose ticket was linked in the same pass gets none.
      const featuresWithoutTickets = (await opts.featuresWithoutTickets?.().catch(() => 0)) ?? 0;
      return { noProgress: noProgressResult, goalChecks, closedCards, featuresWithoutTickets, staleBlockers: staleB, stalledRuns: stalled, urgentIdle: urgentIdleResult, missedWork: missed, releasedUnblocked: releasedResult, idleSlots: idleSlotsResult, stalledReviews: reviews, neverStartedRuns: neverStarted, lostRuns: lost, unmergedApprovals: unmerged, signoffCards, longTicketlessRuns: ticketless, ownerReplies: unanswered, progress, phoneApprove };
    },
  };
}

/**
 * Closes a run's stall alert the moment the run ends or speaks again (BOS-217), so it rarely sits
 * on the CEO's or the owner's queue until the next sweep. The card carries `runActive` and the one
 * closer decides (DR-016, BOS-470), recording one line of why. Safe to call for any event: an event
 * that isn't about a run, or a run with no open alert, does nothing.
 */
export async function closeStallAlertForRun(db: Db, clearing: ReturnType<typeof alertClearing>, runId: string) {
  const [run] = await db.select({ endedAt: runs.endedAt }).from(runs).where(eq(runs.id, runId));
  if (!run) return 0;
  const open = await db
    .select({ id: decisions.id, companyId: decisions.companyId, status: decisions.status, createdAt: decisions.createdAt, question: decisions.question, context: decisions.context })
    .from(decisions)
    .where(and(eq(decisions.kind, "stalled_run"), eq(decisions.status, "open"), sql`${decisions.context}->>'runId' = ${runId}`));
  return clearing.check(open.map((d) => ({ ...d, status: d.status as string })));
}
