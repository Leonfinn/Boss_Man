// Replays the watchdog's rules over the board's history (BOS-58), so its false-alarm rate is
// known before it is switched on. It rebuilds each ticket's state and assignee over time from the
// activity log, runs, wakes, reviews and decisions, then runs the same evaluate() as the live
// sweep every five minutes, with the same de-duplication.
//
// Approximate, and the report says so: some automatic state changes (a run starting a ticket,
// a decision blocking or freeing it) leave no "state" row, so they are inferred from run_started,
// decision_raised and decision_answered rows and from review requests; dependencies that were
// deleted when they resolved are gone. Scheduled checks are read back from the "scheduled a check" and
// "carry on" activity rows; a check the history doesn't show is the one gap left.
import { and, asc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { ticketRef, type WatchdogRule, type WatchdogSettings } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { activity, agents, companies, decisions, reviewRequests, runs, ticketDependencies, ticketReviews, tickets, wakes } from "../db/schema.js";
import { backoffGapMs, evaluate, type SnapHold, type SnapTicket } from "./watchdog-rules.js";

type State = SnapTicket["state"];
const STATES = new Set<State>(["backlog", "ready", "in_progress", "blocked", "review", "done"]);
const STEP_MS = 5 * 60_000;
/** A flag whose ticket moved this soon after it was raised was probably not needed. */
const SELF_RESOLVED_MS = 30 * 60_000;

export type BacktestFlag = { ticketId: string; ref: string; title: string; rule: WatchdogRule; firstAt: string; handOffs: number; clearedAt: string | null; verdict: "cleared within 30 min" | "cleared later" | "still open" };
export type BacktestReport = {
  from: string;
  to: string;
  stepMinutes: number;
  settings: WatchdogSettings;
  flags: BacktestFlag[];
  byRule: Record<string, number>;
  scrumMasterWakes: number;
  busiestHourWakes: number;
  wouldTripCap: boolean;
  /** When the hourly cap would first have switched the watchdog off, if it would. */
  tripAt: string | null;
  caveats: string[];
};

/** A value over time: the latest change at or before t. */
class Timeline<T> {
  private xs: Array<[number, T]> = [];
  constructor(private initial: T) {}
  set(at: Date, v: T) {
    this.xs.push([at.getTime(), v]);
  }
  sort() {
    this.xs.sort((a, b) => a[0] - b[0]);
    return this;
  }
  at(t: number): T {
    let v = this.initial;
    for (const [a, x] of this.xs) {
      if (a > t) break;
      v = x;
    }
    return v;
  }
  /** When the value last changed at or before t (or the fallback). */
  since(t: number, fallback: number): number {
    let s = fallback;
    let v = this.initial;
    for (const [a, x] of this.xs) {
      if (a > t) break;
      if (x !== v) s = a;
      v = x;
    }
    return s;
  }
}

export async function backtest(db: Db, companyId: string, days: number, s: WatchdogSettings, now: Date): Promise<BacktestReport> {
  const to = now.getTime();
  const from = to - days * 86_400_000;
  const [c] = await db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, companyId));
  const all = await db.select().from(tickets).where(eq(tickets.companyId, companyId));
  const ids = all.map((t) => t.id);
  const empty: BacktestReport = { from: new Date(from).toISOString(), to: now.toISOString(), stepMinutes: STEP_MS / 60_000, settings: s, flags: [], byRule: {}, scrumMasterWakes: 0, busiestHourWakes: 0, wouldTripCap: false, tripAt: null, caveats: [] };
  if (!ids.length) return empty;

  const team = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId));
  const byName = new Map(team.map((a) => [a.name, a.id]));
  const acts = await db.select().from(activity).where(and(eq(activity.companyId, companyId), inArray(activity.ticketId, ids))).orderBy(asc(activity.at));
  const runRows = await db.select().from(runs).where(inArray(runs.ticketId, ids));
  const reviewsReq = await db.select({ ticketId: reviewRequests.ticketId, at: reviewRequests.createdAt }).from(reviewRequests).where(inArray(reviewRequests.ticketId, ids));
  const verdicts = await db.select({ ticketId: ticketReviews.ticketId, at: ticketReviews.createdAt }).from(ticketReviews).where(and(inArray(ticketReviews.ticketId, ids), eq(ticketReviews.verdict, "changes_requested")));
  const wakeRows = await db.select({ agentId: wakes.agentId, ticketId: wakes.ticketId, createdAt: wakes.createdAt, launchedAt: wakes.launchedAt, status: wakes.status }).from(wakes).where(inArray(wakes.ticketId, ids));
  const decs = await db.select().from(decisions).where(and(eq(decisions.companyId, companyId), gte(decisions.createdAt, new Date(from - 30 * 86_400_000))));
  const ownerKeys = decs.filter((d) => d.dedupeKey && (d.dedupeKey.startsWith("missed:") || d.dedupeKey.startsWith("merge-stuck:")));
  const deps = await db.select().from(ticketDependencies).where(and(inArray(ticketDependencies.blockedTicketId, ids), isNotNull(ticketDependencies.blockerTicketId)));

  // not state: the replay's working data, built fresh on every call.
  const state = new Map<string, Timeline<State>>();
  const assignee = new Map<string, Timeline<string | null>>();
  // Decision holds: [ticket, decisionId, from, until]
  const decisionHolds: Array<{ ticketId: string; decisionId: string; from: number; until: number }> = [];
  for (const t of all) {
    const st = new Timeline<State>("backlog");
    st.set(t.createdAt, "backlog");
    const asg = new Timeline<string | null>(null);
    const mine = acts.filter((a) => a.ticketId === t.id);
    const firstAssigned = mine.find((a) => a.kind === "assigned");
    const created = mine.find((a) => a.kind === "ticket_created");
    // Created assigned, or assigned in the same minute: it was never really unassigned.
    if (created?.summary.includes(", assigned") || (firstAssigned && firstAssigned.at.getTime() - t.createdAt.getTime() < 60_000)) {
      const firstTarget = firstAssigned ? (byName.get(firstAssigned.summary.replace(/^Assigned to /, "")) ?? null) : t.assigneeAgentId;
      asg.set(t.createdAt, firstTarget);
    }
    if (!firstAssigned) asg.set(t.createdAt, t.assigneeAgentId);
    const created0 = /Created ".*" in (\w+)/.exec(created?.summary ?? "")?.[1] as State | undefined;
    if (created0 && STATES.has(created0)) st.set(t.createdAt, created0);
    for (const a of mine) {
      if (a.kind === "state") {
        const m = /^(?:\w+ )?-> (\w+)/.exec(a.summary);
        if (m && STATES.has(m[1] as State)) st.set(a.at, m[1] as State);
      } else if (a.kind === "assigned") {
        const name = a.summary.replace(/^Assigned to /, "");
        asg.set(a.at, name === "nobody" ? null : (byName.get(name) ?? t.assigneeAgentId));
      } else if (a.kind === "run_started") {
        const cur = st.sort().at(a.at.getTime());
        if (cur === "backlog" || cur === "ready") st.set(a.at, "in_progress");
      } else if (a.kind === "decision_raised") {
        st.set(a.at, "blocked");
        const q = a.summary.replace(/^Asked the owner: /, "");
        const d = decs.find((x) => x.question === q && Math.abs(x.createdAt.getTime() - a.at.getTime()) < 60_000);
        if (d) decisionHolds.push({ ticketId: t.id, decisionId: d.id, from: d.createdAt.getTime(), until: d.answeredAt?.getTime() ?? (d.status === "open" ? Infinity : -1) });
      } else if (a.kind === "decision_answered") {
        if (st.sort().at(a.at.getTime()) === "blocked") st.set(a.at, "ready");
      }
    }
    for (const r of reviewsReq.filter((x) => x.ticketId === t.id)) st.set(r.at, "review");
    // The ticket's state now is certain: it got there at state_changed_at.
    st.set(t.stateChangedAt, t.systemState);
    state.set(t.id, st.sort());
    assignee.set(t.id, asg.sort());
  }
  // A withdrawn decision's end isn't recorded: it ended when the ticket next left blocked.
  for (const h of decisionHolds) {
    if (h.until !== -1) continue;
    const st = state.get(h.ticketId)!;
    let t = h.from;
    while (t < to && st.at(t) === "blocked") t += STEP_MS;
    h.until = t;
  }
  const doneAt = new Map(all.map((t) => [t.id, t.systemState === "done" ? t.stateChangedAt.getTime() : Infinity]));
  // Indexed by ticket, since every step looks them up for every ticket.
  const group = <T,>(xs: T[], key: (x: T) => string | null) => {
    const m = new Map<string, T[]>();
    for (const x of xs) {
      const k = key(x);
      if (k) m.set(k, [...(m.get(k) ?? []), x]);
    }
    return m;
  };
  const carryOn = group(
    acts.filter((a) => a.kind === "monitor" && a.summary.includes("to carry on")),
    (a) => a.ticketId,
  );
  // A scheduled check runs from the row that set it to its time, or to the next row on the ticket's
  // monitor (cleared, fired, replaced), whichever comes first.
  const checks = new Map<string, Array<[number, number]>>();
  for (const [id, rows] of group(acts.filter((a) => a.kind === "monitor"), (a) => a.ticketId)) {
    const list: Array<[number, number]> = [];
    rows.forEach((a, i) => {
      const m = /scheduled a check for (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(a.summary);
      if (m) list.push([a.at.getTime(), Math.min(new Date(m[1]!).getTime(), rows[i + 1]?.at.getTime() ?? Infinity)]);
    });
    checks.set(id, list);
  }
  const messagesBy = group(
    acts.filter((a) => a.kind === "message"),
    (a) => a.ticketId,
  );
  const runStartsBy = group(runRows.filter((r) => r.ticketId), (r) => r.ticketId);
  const wakesBy = group(wakeRows, (w) => w.ticketId);
  const verdictsBy = group(verdicts, (v) => v.ticketId);
  const ownerBy = group(ownerKeys, (d) => d.dedupeKey!.split(":")[1] ?? null);

  const runsOf = runRows
    .filter((r) => r.purpose !== "chat" && r.ticketId)
    .map((r) => ({ id: r.id, ticketId: r.ticketId!, agentId: r.agentId, startedAt: r.startedAt, endedAt: r.endedAt, outcome: r.outcome }));

  type Episode = { ticketId: string; rule: WatchdogRule; firstAt: number; dueAt: number; handOffs: number; clearedAt: number | null; lastAt: number; steps: number };
  // not state: per call.
  const open = new Map<string, Episode>();
  const episodes: Episode[] = [];
  const wakesAt: number[] = [];
  for (let t = from; t <= to; t += STEP_MS) {
    const at = new Date(t);
    const snapTickets: SnapTicket[] = [];
    for (const x of all) {
      if (x.createdAt.getTime() > t) continue;
      const st = state.get(x.id)!;
      const cur = st.at(t);
      const who = assignee.get(x.id)!.at(t);
      snapTickets.push({
        id: x.id,
        state: cur,
        assigneeAgentId: who,
        assignedToOwner: x.assignedToOwner,
        stateChangedAt: new Date(st.since(t, x.createdAt.getTime())),
        blockedUntil: null,
        scheduled:
          (checks.get(x.id) ?? []).some(([a, b]) => a <= t && t < b) ||
          (carryOn.get(x.id) ?? []).some((a) => a.at.getTime() <= t && t - a.at.getTime() < 20 * 60_000) ||
          (wakesBy.get(x.id) ?? []).some((w) => w.agentId === who && w.createdAt.getTime() <= t && (w.launchedAt ? w.launchedAt.getTime() > t : w.status === "queued" || w.status === "deferred")),
        awaitingPlan: x.planFirst && (!x.planApprovedAt || x.planApprovedAt.getTime() > t),
        withOwner: (ownerBy.get(x.id) ?? []).some((d) => d.createdAt.getTime() <= t && (!d.answeredAt || d.answeredAt.getTime() > t)),
        bounces: (verdictsBy.get(x.id) ?? []).filter((v) => v.at.getTime() <= t).length,
      });
    }
    const holds: SnapHold[] = [
      ...decisionHolds.filter((h) => h.from <= t).map((h) => ({ blockedTicketId: h.ticketId, kind: "decision" as const, decisionId: h.decisionId, resolved: h.until <= t, openedAt: new Date(h.from) })),
      ...deps.map((d) => ({ blockedTicketId: d.blockedTicketId, kind: "ticket" as const, holderTicketId: d.blockerTicketId!, resolved: (doneAt.get(d.blockerTicketId!) ?? Infinity) <= t })),
    ];
    const trips = evaluate({ tickets: snapTickets, runs: runsOf.filter((r) => r.startedAt.getTime() <= t).map((r) => ({ ...r, endedAt: r.endedAt && r.endedAt.getTime() <= t ? r.endedAt : null })), holds }, s, at);
    const seen = new Set<string>();
    let handed = 0;
    for (const trip of trips) {
      const key = `${trip.ticketId}|${trip.rule}`;
      seen.add(key);
      let e = open.get(key);
      if (!e) {
        e = { ticketId: trip.ticketId, rule: trip.rule, firstAt: t, dueAt: t, handOffs: 0, clearedAt: null, lastAt: t, steps: 0 };
        open.set(key, e);
        episodes.push(e);
      }
      if (e.dueAt <= t && trip.rule !== "owner_decision_waiting") {
        // Same back-off as the live sweep: the gap doubles unless something happened on the ticket since the last hand-off.
        const snapT = snapTickets.find((y) => y.id === trip.ticketId)!;
        const moved =
          e.handOffs > 0 &&
          (snapT.stateChangedAt.getTime() > e.lastAt ||
            (runStartsBy.get(trip.ticketId) ?? []).some((r) => r.startedAt.getTime() > e.lastAt && r.startedAt.getTime() <= t) ||
            (messagesBy.get(trip.ticketId) ?? []).some((a) => a.at.getTime() > e.lastAt && a.at.getTime() <= t));
        if (moved) e.steps = 0;
        e.handOffs++;
        e.dueAt = t + backoffGapMs(trip.rule, s, e.steps);
        e.steps++;
        e.lastAt = t;
        handed++;
      }
    }
    for (const [key, e] of open)
      if (!seen.has(key)) {
        e.clearedAt = t;
        open.delete(key);
      }
    if (handed) wakesAt.push(t);
  }

  // One sweep is one wake however many flags it lists, as in the live sweep; the live cap trips on the wake that would be one too many.
  let busiest = 0;
  let tripAt: number | null = null;
  for (let i = 0, j = 0; i < wakesAt.length; i++) {
    while (wakesAt[i]! - wakesAt[j]! >= 3_600_000) j++;
    busiest = Math.max(busiest, i - j + 1);
    if (tripAt === null && i - j + 1 > s.maxSmRunsPerHour) tripAt = wakesAt[i]!;
  }
  const titles = new Map(all.map((t) => [t.id, { ref: ticketRef(c?.prefix, t.number) ?? t.id, title: t.title }]));
  const flags: BacktestFlag[] = episodes.map((e) => ({
    ticketId: e.ticketId,
    ref: titles.get(e.ticketId)!.ref,
    title: titles.get(e.ticketId)!.title,
    rule: e.rule,
    firstAt: new Date(e.firstAt).toISOString(),
    handOffs: e.handOffs,
    clearedAt: e.clearedAt ? new Date(e.clearedAt).toISOString() : null,
    verdict: e.clearedAt === null ? "still open" : e.clearedAt - e.firstAt <= SELF_RESOLVED_MS ? "cleared within 30 min" : "cleared later",
  }));
  const byRule: Record<string, number> = {};
  for (const f of flags) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return {
    ...empty,
    flags,
    byRule,
    scrumMasterWakes: wakesAt.length,
    busiestHourWakes: busiest,
    wouldTripCap: tripAt !== null,
    tripAt: tripAt === null ? null : new Date(tripAt).toISOString(),
    caveats: [
      "State history is rebuilt from the activity log; changes made by a run starting, a decision blocking or freeing a ticket, and review requests are inferred, so times can be a few minutes off.",
      "Dependencies on other tickets that were deleted when they resolved are not in the history; such tickets may show as stale_blocked instead of held.",
      "Scheduled checks are read back from the activity log; one that left no row there is missed, so its ticket may be flagged when the live watchdog would not.",
      "'blocked until' did not exist before BOS-59, so no ticket in the history has one.",
      "Parked wakes of paused agents are not in the history, so a ticket whose assignee was paused may show as a plan instead of a stall.",
      "A very long problem list is split over several wakes live (about 30,000 characters each); here every sweep counts as one wake.",
      "'cleared within 30 min' is a hint, not a verdict: each flag still needs a look at its ticket to call it a true or false alarm.",
    ],
  };
}
