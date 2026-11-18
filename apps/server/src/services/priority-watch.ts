// Priority watch (BOS-1514, fix A of BOS-1511): every 5 minutes, each urgent ticket must have a next step
// under way, and the CEO hears at once when it has not. The only idle alarm before this (urgentIdle in
// sweeps.ts) covered urgent In-progress tickets and could only wake the assignee.
//
// A next step is under way when the ticket has one of: a live run, a queued wake, a queued or running check
// job, a review with a reviewer, a merge check on the line, an open owner card (or a card waiting on the
// ticket), an open waits-on, or a booked check / blocked-until date still ahead.
//
// An alarm is raised for: nothing under way; a run cut off; a move backwards; "left" the merge line; or
// waiting for a merge-train seat while one is free. The CEO is woken at once (a "waiting" class wake, which
// is never dropped). The owner gets one notification per stop if it is still stopped OWNER_AFTER_MS later,
// read again when the ticket moves. Every alert quotes live rows (runs, check jobs, merge-line rows), never
// ticket notes. Merge-line records and check jobs are read only; review.ts is not touched.
//
// BOS-1509 (CEO told when urgent work goes backwards) had not merged when this was written, so the
// backwards-move case is read here from the ticket's state history instead.
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { ageWords, ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { ticketBlockerFinished } from "./ticket-links.js";
import { activity, agents, checkJobs, companies, decisions, notifications, reviewRequests, runs, settings, ticketDependencies, tickets, wakes } from "../db/schema.js";
import { CHECK_SLOTS_KEY, DEFAULT_CHECK_SLOTS } from "./check-queue.js";
import { MERGE_LINE_KIND } from "./merge-line.js";
import { HELD_AGENT } from "./fair-share.js";
import { isBackgroundLaneTitle } from "./check-gate.js";
import { heldTicketIds } from "./review-holds.js";

export const PRIORITY_WATCH_REASON = "priority watch";
/** The sweep runs on every pass; it does its work this often. */
export const WATCH_EVERY_MS = 5 * 60_000;
/** Nothing under way for this long before it counts as stopped (a run that has just ended is not a stop). */
export const QUIET_AFTER_MS = 5 * 60_000;
/** The owner hears if the ticket is still stopped this long after the CEO was told. */
export const OWNER_AFTER_MS = 15 * 60_000;
/** An event (a move back, a cut-off run, leaving the line) older than this is no longer news. */
export const EVENT_WINDOW_MS = 15 * 60_000;

const RANK: Record<string, number> = { backlog: 0, ready: 1, in_progress: 2, review: 3 };
const CUT_OFF = /^(interrupted|cancelled|lost:|error:|stopped)/i;

/** BOS-1547: a merged ticket waiting for go-live this long (the update card or deploy still open) tells the CEO. */
export const GO_LIVE_SLOW_MS = 2 * 60 * 60_000;

/** BOS-1635: an urgent Ready ticket whose wake has waited this long behind its busy agent tells the CEO, once. */
export const HELD_BUSY_AFTER_MS = 30 * 60_000;

export type Cause = "nothing" | "cut_off" | "moved_back" | "left_line" | "seat_free" | "go_live_slow" | "held_busy";

export type Facts = {
  state: string;
  /** Latest sign of life on the ticket: its last change, last run event, last wake. */
  lastActiveAt: Date;
  liveRuns: Array<{ agent: string | null; startedAt: Date }>;
  queuedWakes: number;
  deferredWakes: Array<string | null>;
  checkJobs: Array<{ kind: string; state: string; reason: string | null }>;
  pendingReviews: number;
  openCards: number;
  openWaitsOn: number;
  bookedUntil: Date | null;
  /** The ticket's last merge-line row, if it is in the line. */
  line: { event: string; hold?: string; at: Date; to?: string } | null;
  seatsFree: boolean;
  lastRun: { id: string; outcome: string | null; endedAt: Date | null } | null;
  /** The newest backwards state move in the event window, from the history. */
  movedBack: { id: string; text: string } | null;
  /** The merge-line "left" row in the event window. */
  left: { id: string; to: string } | null;
  /** BOS-1547: merged, with after-merge checks waiting for go-live; null once it is live (or if it never waited). */
  goLive?: { wait: string; since: Date | null } | null;
  /** BOS-1635: the ticket's wake waits on "this agent is busy"; who, since when, the run it waits behind, and the free foreground agents. */
  heldBusy?: { agent: string; since: Date; behind: string | null; free: string[]; key: string } | null;
  /** BOS-1717: the ticket's hold is recorded: an open waits-on link or an open system hold. */
  heldOnRecord?: boolean;
};

export type Verdict = {
  /** What is under way, in words from live rows; empty when nothing is. */
  underWay: string[];
  /** The alarms, one key each; the key says which stop this is, so one stop is told once. */
  alarms: Array<{ cause: Cause; key: string; text: string }>;
};

/** Pure: what is under way and what to alarm on, from the facts. */
export function judge(f: Facts, now: Date): Verdict {
  // BOS-1717: an approved ticket held in review on a waits-on link or a system hold is waiting on purpose; its hold
  // ending wakes its assignee, so no alarm (and no wake) is raised for it here.
  if (f.state === "review" && f.heldOnRecord) return { underWay: ["held in review on a recorded waits-on link or system hold"], alarms: [] };
  const under: string[] = [];
  if (f.liveRuns.length) under.push(`a run is live (${f.liveRuns.map((r) => r.agent ?? "an agent").join(", ")})`);
  if (f.queuedWakes) under.push(`${f.queuedWakes} wake${f.queuedWakes === 1 ? "" : "s"} queued`);
  const jobs = f.checkJobs.filter((j) => j.state === "queued" || j.state === "running");
  if (jobs.length) under.push(`${jobs.map((j) => `${j.kind} check ${j.state}`).join(", ")}`);
  if (f.pendingReviews) under.push(`${f.pendingReviews} review${f.pendingReviews === 1 ? "" : "s"} with a reviewer`);
  const lineEv = f.line;
  const waitingSeat = lineEv?.event === "hold_started" && lineEv.hold === "train";
  if (lineEv && (lineEv.event === "check_queued" || lineEv.event === "check_started")) under.push(`merge check ${lineEv.event === "check_started" ? "running" : "queued"}`);
  if (lineEv && lineEv.event === "hold_started" && (lineEv.hold === "sign_off" || lineEv.hold === "card") && f.openCards) under.push("merge held on an open card");
  if (lineEv && lineEv.event === "hold_started" && lineEv.hold === "waits_on" && f.openWaitsOn) under.push("merge held on a waits-on");
  if (f.openCards) under.push(`${f.openCards} open owner card${f.openCards === 1 ? "" : "s"}`);
  if (f.state === "blocked" && f.openWaitsOn) under.push(`waiting on ${f.openWaitsOn} open blocker${f.openWaitsOn === 1 ? "" : "s"}`);
  if (f.bookedUntil && f.bookedUntil > now) under.push(`a check or date is booked for ${f.bookedUntil.toISOString()}`);
  // BOS-1547: a merged ticket whose after-merge checks wait for go-live is a step under way, kept in view until
  // it is live (the wait is then cleared and the ticket is woken). Too long a wait tells the CEO, never "stopped".
  let slowGoLive: string | null = null;
  if (f.goLive) {
    const what = f.goLive.wait === "own" ? "the company's own deploy" : f.goLive.wait === "runner" ? "the runner rebuild" : f.goLive.wait === "both" ? "the server update and the runner rebuild" : "the server update";
    under.push(`merged, waiting for ${what}`);
    if (f.goLive.since && now.getTime() - f.goLive.since.getTime() >= GO_LIVE_SLOW_MS) slowGoLive = `merged ${ageWords(now.getTime() - f.goLive.since.getTime())} ago and still waiting for ${what}`;
  }
  // A merge attempt that has just started has not yet queued its check.
  if (lineEv && (lineEv.event === "attempt" || lineEv.event === "approved") && now.getTime() - lineEv.at.getTime() < QUIET_AFTER_MS) under.push("merge attempt starting");
  const live = under.length > 0;

  const alarms: Verdict["alarms"] = [];
  const seen = (what: string) => `${what}; still on live state: ${under.length ? under.join("; ") : "nothing under way"}`;
  if (f.movedBack) alarms.push({ cause: "moved_back", key: `moved_back:${f.movedBack.id}`, text: seen(`moved backwards (${f.movedBack.text})`) });
  if (f.left) alarms.push({ cause: "left_line", key: `left:${f.left.id}`, text: seen(`sent back from the merge line (left, moved to ${f.left.to})`) });
  const lr = f.lastRun;
  if (lr && lr.endedAt && lr.outcome && CUT_OFF.test(lr.outcome) && !f.liveRuns.length && now.getTime() - lr.endedAt.getTime() < EVENT_WINDOW_MS) {
    alarms.push({ cause: "cut_off", key: `cut_off:${lr.id}`, text: seen(`its last run was cut off (${lr.outcome}, ended ${ageWords(now.getTime() - lr.endedAt.getTime())} ago)`) });
  }
  if (waitingSeat && f.seatsFree && now.getTime() - lineEv!.at.getTime() >= QUIET_AFTER_MS) {
    alarms.push({ cause: "seat_free", key: `seat_free:${lineEv!.at.toISOString()}`, text: `it has waited ${ageWords(now.getTime() - lineEv!.at.getTime())} for a merge-train seat while a check slot is free` });
  }
  if (slowGoLive) alarms.push({ cause: "go_live_slow", key: `go_live_slow:${f.goLive!.since!.toISOString()}`, text: `${slowGoLive}; this is the update step, not a stopped ticket` });
  if (f.state === "ready" && f.heldBusy && now.getTime() - f.heldBusy.since.getTime() >= HELD_BUSY_AFTER_MS) {
    const h = f.heldBusy;
    alarms.push({
      cause: "held_busy",
      key: `held_busy:${h.key}`,
      text: `its wake has been held ${ageWords(now.getTime() - h.since.getTime())} because ${h.agent} is busy${h.behind ? `, with a run on ${h.behind}` : ""}. Free foreground agents: ${h.free.length ? h.free.join(", ") : "none"}. Boss Man doesn't move started work by itself: reassign it with assign_ticket if another agent fits`,
    });
  }
  const quiet = now.getTime() - f.lastActiveAt.getTime() >= QUIET_AFTER_MS;
  if (!live && quiet && !waitingSeat) {
    const why = f.deferredWakes.length ? `; ${f.deferredWakes.length} wake${f.deferredWakes.length === 1 ? " is" : "s are"} held (${f.deferredWakes[0] ?? "no reason recorded"})` : "";
    const last = lr ? `; last run ${lr.endedAt ? `ended ${lr.outcome ?? "without an outcome"}` : "has no end"}` : "; it has never had a run";
    alarms.push({ cause: "nothing", key: `nothing:${f.state}`, text: `nothing is under way (${f.state}, quiet for ${ageWords(now.getTime() - f.lastActiveAt.getTime())}${last}${why})` });
  }
  return { underWay: under, alarms };
}

/** Whether the ticket is stopped now (not just news): nothing under way, or a merge-train seat idle. */
export const stopped = (v: Verdict) => v.alarms.some((a) => a.cause === "nothing" || a.cause === "seat_free");

type Episode = {
  /** Keys already told to the CEO for this ticket. */
  told: string[];
  /** When the ticket was first seen stopped, in this stop. Null while it is moving. */
  stoppedAt: string | null;
  ownerNotificationId: string | null;
  ownerTold: boolean;
};

const KEY = (ticketId: string) => `priority_watch:${ticketId}`;
const blank = (): Episode => ({ told: [], stoppedAt: null, ownerNotificationId: null, ownerTold: false });

export function priorityWatchService(
  db: Db,
  deps: {
    /** Wakes the company's CEO on the ticket, on a wake that is never dropped. */
    tellCeo: (input: { companyId: string; ticketId: string; note: string }) => Promise<unknown>;
    notify: (input: { companyId: string; level: "note" | "flag" | "page"; title: string; body: string; link: string }) => Promise<{ id: string; level: string } | null>;
    now?: () => Date;
  },
) {
  const now = deps.now ?? (() => new Date());
  let lastRunAt = 0;

  async function read(ticketId: string): Promise<Episode> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY(ticketId)));
    return (row?.value as Episode | undefined) ?? blank();
  }
  async function write(ticketId: string, e: Episode | null) {
    if (!e) {
      await db.delete(settings).where(eq(settings.key, KEY(ticketId)));
      return;
    }
    await db.insert(settings).values({ key: KEY(ticketId), value: e }).onConflictDoUpdate({ target: settings.key, set: { value: e } });
  }

  async function gather(t: typeof tickets.$inferSelect, at: Date): Promise<Facts> {
    const since = new Date(at.getTime() - EVENT_WINDOW_MS);
    const liveRuns = await db.select({ agent: agents.name, startedAt: runs.startedAt }).from(runs).leftJoin(agents, eq(agents.id, runs.agentId)).where(and(eq(runs.ticketId, t.id), isNull(runs.endedAt)));
    const [lastRun] = await db.select({ id: runs.id, outcome: runs.outcome, endedAt: runs.endedAt, startedAt: runs.startedAt, lastEventAt: runs.lastEventAt }).from(runs).where(eq(runs.ticketId, t.id)).orderBy(desc(runs.startedAt)).limit(1);
    const wk = await db.select({ status: wakes.status, why: wakes.statusReason, createdAt: wakes.createdAt }).from(wakes).where(and(eq(wakes.ticketId, t.id), inArray(wakes.status, ["queued", "deferred"])));
    const jobs = await db.select({ kind: checkJobs.kind, state: checkJobs.state, reason: checkJobs.reason }).from(checkJobs).where(and(eq(checkJobs.ticketId, t.id), inArray(checkJobs.state, ["queued", "running"])));
    const [{ n: pendingReviews = 0 } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(reviewRequests)
      .where(and(eq(reviewRequests.ticketId, t.id), eq(reviewRequests.status, "pending"), sql`${reviewRequests.reviewerAgentId} is not null`));
    const [{ n: openCards = 0 } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(decisions)
      .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'ticketId' = ${t.id}`));
    const deps2 = await db
      .select({ ticketState: tickets.systemState, mergeCommit: tickets.mergeCommit, until: ticketDependencies.until })
      .from(ticketDependencies)
      .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
      .where(eq(ticketDependencies.blockedTicketId, t.id));
    const openWaitsOn = deps2.filter((d) => !ticketBlockerFinished(d)).length;
    const lineRows = await db
      .select({ id: activity.id, at: activity.at, detail: activity.detail })
      .from(activity)
      .where(and(eq(activity.ticketId, t.id), eq(activity.kind, MERGE_LINE_KIND)))
      .orderBy(desc(activity.at))
      .limit(6);
    const last = lineRows.find((r) => !["hold_ended"].includes((r.detail as { event: string }).event));
    const d = last?.detail as { event: string; hold?: string; to?: string } | undefined;
    const line = last && d && d.event !== "merged" && d.event !== "left" ? { event: d.event, hold: d.hold, at: last.at } : null;
    const leftRow = lineRows.find((r) => (r.detail as { event: string }).event === "left" && r.at >= since);
    const stateRows = await db
      .select({ id: activity.id, summary: activity.summary })
      .from(activity)
      .where(and(eq(activity.ticketId, t.id), eq(activity.kind, "state"), gte(activity.at, since)))
      .orderBy(desc(activity.at));
    let movedBack: Facts["movedBack"] = null;
    for (const r of stateRows) {
      const m = /^(\w+) -> (\w+)/.exec(r.summary);
      if (!m) continue;
      const from = RANK[m[1]!];
      // Blocked counts as a move back only from review; in_progress -> blocked is a normal wait.
      const to = m[2] === "blocked" ? (m[1] === "review" ? -1 : undefined) : RANK[m[2]!];
      if (from !== undefined && to !== undefined && to < from) {
        movedBack = { id: r.id, text: `${m[1]} -> ${m[2]}` };
        break;
      }
    }
    // Seats free: fewer merge jobs on the line than the check slots.
    const [slotRow] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, CHECK_SLOTS_KEY));
    const slots = typeof slotRow?.value === "number" && slotRow.value > 0 ? slotRow.value : DEFAULT_CHECK_SLOTS;
    const [{ n: busyJobs = 0 } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(checkJobs)
      .where(and(eq(checkJobs.companyId, t.companyId), eq(checkJobs.kind, "merge"), eq(checkJobs.state, "running"), ne(checkJobs.ticketId, t.id)));
    let heldBusy: Facts["heldBusy"] = null;
    const heldWake = t.systemState === "ready" && t.assigneeAgentId ? await db.select({ id: wakes.id, createdAt: wakes.createdAt }).from(wakes).where(and(eq(wakes.ticketId, t.id), eq(wakes.status, "queued"), eq(wakes.statusReason, HELD_AGENT))).orderBy(wakes.createdAt).limit(1) : [];
    if (heldWake[0]) {
      const [owner] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, t.assigneeAgentId!));
      const [behindRun] = await db.select({ title: tickets.title, number: tickets.number }).from(runs).leftJoin(tickets, eq(tickets.id, runs.ticketId)).where(and(eq(runs.agentId, t.assigneeAgentId!), isNull(runs.endedAt))).limit(1);
      const [co] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, t.companyId));
      const candidates = await db.select({ id: agents.id, name: agents.name, title: agents.title }).from(agents).where(and(eq(agents.companyId, t.companyId), ne(agents.role, "ceo"), eq(agents.paused, false), isNull(agents.retiredAt), ne(agents.id, t.assigneeAgentId!)));
      const working = new Set((await db.select({ id: runs.agentId }).from(runs).where(and(eq(runs.companyId, t.companyId), isNull(runs.endedAt)))).map((r) => r.id));
      heldBusy = {
        agent: owner?.name ?? "the assignee",
        since: heldWake[0].createdAt,
        behind: behindRun ? `${ticketRef(co?.prefix ?? null, behindRun.number) ?? "a ticket"} "${behindRun.title}"` : null,
        free: candidates.filter((a) => !isBackgroundLaneTitle(a.title) && !working.has(a.id)).map((a) => `${a.name} (${a.title ?? "agent"})`),
        key: heldWake[0].id,
      };
    }
    const times = [t.lastActivityAt, lastRun?.lastEventAt, lastRun?.endedAt, lastRun?.startedAt, ...wk.map((w) => w.createdAt)].filter((x): x is Date => !!x);
    return {
      state: t.systemState,
      lastActiveAt: new Date(Math.max(...times.map((x) => x.getTime()))),
      liveRuns,
      queuedWakes: wk.filter((w) => w.status === "queued").length,
      deferredWakes: wk.filter((w) => w.status === "deferred").map((w) => w.why),
      checkJobs: jobs,
      pendingReviews,
      openCards,
      openWaitsOn,
      bookedUntil: [t.monitorAt, t.blockedUntil].filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
      line,
      seatsFree: busyJobs < slots,
      lastRun: lastRun ? { id: lastRun.id, outcome: lastRun.outcome, endedAt: lastRun.endedAt } : null,
      movedBack,
      heldBusy,
      heldOnRecord: openWaitsOn > 0 || (await heldTicketIds(db, [t.id])).has(t.id),
      goLive: t.goLiveWait ? { wait: t.goLiveWait, since: t.goLiveWaitSince } : null,
      left: leftRow ? { id: leftRow.id, to: (leftRow.detail as { to?: string }).to ?? "another state" } : null,
    };
  }

  return {
    /** One pass: at most once every 5 minutes. Safe to call every minute. */
    async run(force = false): Promise<{ checked: number; told: number; ownerTold: number; cleared: number }> {
      const t = now();
      const out = { checked: 0, told: 0, ownerTold: 0, cleared: 0 };
      if (!force && t.getTime() - lastRunAt < WATCH_EVERY_MS) return out;
      lastRunAt = t.getTime();
      const rows = await db
        .select({ ticket: tickets, prefix: companies.ticketPrefix })
        .from(tickets)
        .innerJoin(companies, eq(companies.id, tickets.companyId))
        .where(and(eq(tickets.urgent, true), ne(tickets.systemState, "done"), eq(companies.paused, false)));
      // A ticket that is no longer urgent or has finished: its episode and owner notification go.
      const liveIds = new Set(rows.map((r) => r.ticket.id));
      const stale = await db.select({ key: settings.key }).from(settings).where(sql`${settings.key} like 'priority_watch:%'`);
      for (const { key } of stale) {
        const id = key.slice("priority_watch:".length);
        if (liveIds.has(id)) continue;
        const e = await read(id);
        if (e.ownerNotificationId) await db.update(notifications).set({ readAt: t }).where(and(eq(notifications.id, e.ownerNotificationId), isNull(notifications.readAt)));
        await write(id, null);
        out.cleared++;
      }
      for (const { ticket, prefix } of rows) {
        out.checked++;
        const verdict = judge(await gather(ticket, t), t);
        const e = await read(ticket.id);
        const ref = ticketRef(prefix, ticket.number) ?? ticket.id;
        if (!verdict.alarms.length) {
          if (e.stoppedAt || e.ownerNotificationId || e.told.length) {
            if (e.ownerNotificationId) await db.update(notifications).set({ readAt: t }).where(and(eq(notifications.id, e.ownerNotificationId), isNull(notifications.readAt)));
            await write(ticket.id, null);
            out.cleared++;
          }
          continue;
        }
        const fresh = verdict.alarms.filter((a) => !e.told.includes(a.key));
        const isStopped = stopped(verdict);
        if (fresh.length) {
          const note = `Priority watch: ${ref} "${ticket.title}" is urgent and its next step is in doubt. ${fresh.map((a) => `Cause: ${a.text}.`).join(" ")} Get it moving now, or say what is blocking it.`;
          await deps.tellCeo({ companyId: ticket.companyId, ticketId: ticket.id, note }).catch(() => undefined);
          e.told = [...e.told, ...fresh.map((a) => a.key)].slice(-20);
          out.told++;
        }
        if (isStopped) {
          if (!e.stoppedAt) e.stoppedAt = t.toISOString();
          else if (!e.ownerTold && t.getTime() - new Date(e.stoppedAt).getTime() >= OWNER_AFTER_MS) {
            const worst = verdict.alarms.find((a) => a.cause === "nothing" || a.cause === "seat_free")!;
            const sent = await deps
              .notify({ companyId: ticket.companyId, level: "flag", title: `${ref} is urgent and still stopped`, body: `${ref} "${ticket.title}": ${worst.text}. The CEO was told ${ageWords(t.getTime() - new Date(e.stoppedAt).getTime())} ago and it has not moved.`, link: `#/tickets/${ticket.id}` })
              .catch(() => null);
            e.ownerTold = true;
            e.ownerNotificationId = sent?.id ?? null;
            out.ownerTold++;
          }
        } else if (e.stoppedAt) {
          // Moving again (a step is under way): this stop is over, the card goes, the next stop starts afresh.
          if (e.ownerNotificationId) await db.update(notifications).set({ readAt: t }).where(and(eq(notifications.id, e.ownerNotificationId), isNull(notifications.readAt)));
          e.stoppedAt = null;
          e.ownerTold = false;
          e.ownerNotificationId = null;
        }
        await write(ticket.id, e);
      }
      return out;
    },
  };
}
