// The watchdog's rules (BOS-58) as one pure function over a snapshot of the board, so the live
// sweep and the backtest over history run exactly the same checks. No database, no model.
import type { WatchdogRule, WatchdogSettings } from "@boss-man/shared";

export type SnapTicket = {
  id: string;
  state: "backlog" | "ready" | "in_progress" | "blocked" | "review" | "done";
  assigneeAgentId: string | null;
  assignedToOwner: boolean;
  stateChangedAt: Date;
  blockedUntil: Date | null;
  /** Something is set to wake the assignee and will happen: a scheduled check or a wake that is not parked behind a paused agent. */
  scheduled: boolean;
  /** Plan-first and its plan isn't approved yet: it waits on the approver, not the assignee. */
  awaitingPlan: boolean;
  /** Already in the owner's queue through another sweep (missed work, merge stuck, review stall). */
  withOwner: boolean;
  /** In review with every review passed: it waits for the merge sweep, not for a reviewer or its author (BOS-362). */
  mergeWaiting?: boolean;
  /** The ticket was made ready and then released from its last blocker at this time (BOS-659). */
  unblockedAt?: Date | null;
  /** Send-backs so far. */
  bounces: number;
};

export type SnapRun = { id: string; ticketId: string; agentId: string | null; startedAt: Date; endedAt: Date | null; outcome: string | null };

/** What holds a ticket: another ticket, an engagement, or a decision (with its age when open). */
export type SnapHold =
  | { blockedTicketId: string; kind: "ticket"; holderTicketId: string; resolved: boolean }
  | { blockedTicketId: string; kind: "engagement"; resolved: boolean }
  | { blockedTicketId: string; kind: "decision"; decisionId: string; resolved: boolean; openedAt: Date };

export type Snapshot = { tickets: SnapTicket[]; runs: SnapRun[]; holds: SnapHold[] };

export type Trip = {
  ticketId: string;
  rule: WatchdogRule;
  detail: { idleMs?: number; limitMs?: number; runId?: string; runOutcome?: string | null; decisionId?: string; holds?: number; bounces?: number; blockedUntil?: string };
};

/**
 * How long after a run ends before "crashed" or "ended without moving" trips. Long enough for
 * Boss Man's own free fixes to go first: recovery of an interrupted run (R42), its 15-minute
 * "carry on" check, and the missed-work nudge after 30 minutes (R82). The Scrum Master is told
 * only when those didn't move it.
 */
export const RUN_ENDED_GRACE_MS = 45 * 60_000;

/** Run endings that are normal: the agent finished its turn, or someone stopped it. Anything else is a crash. */
const NORMAL_ENDINGS = new Set(["end_turn", "cancelled", "max_tokens", "max_turn_requests"]);
export const isCrash = (outcome: string | null) => outcome !== null && !NORMAL_ENDINGS.has(outcome);

const H = 3_600_000;

/** Total time in [from, to] covered by the given intervals, overlaps counted once. */
function covered(intervals: Array<[number, number]>, from: number, to: number) {
  const xs = intervals
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of xs) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

export function evaluate(snap: Snapshot, s: WatchdogSettings, now: Date): Trip[] {
  const t = now.getTime();
  // not state: lookups built fresh on every call.
  const runsBy = new Map<string, SnapRun[]>();
  for (const r of snap.runs) runsBy.set(r.ticketId, [...(runsBy.get(r.ticketId) ?? []), r]);
  // not state: per call.
  const holdsBy = new Map<string, SnapHold[]>();
  for (const h of snap.holds) holdsBy.set(h.blockedTicketId, [...(holdsBy.get(h.blockedTicketId) ?? []), h]);
  // Rule 1: a ticket holding others is chased itself; the count goes into its flag.
  // not state: per call.
  const holding = new Map<string, number>();
  const open = new Set(snap.tickets.filter((x) => x.state !== "done").map((x) => x.id));
  for (const h of snap.holds) if (h.kind === "ticket" && !h.resolved && open.has(h.blockedTicketId)) holding.set(h.holderTicketId, (holding.get(h.holderTicketId) ?? 0) + 1);

  const trips: Trip[] = [];
  for (const x of snap.tickets) {
    if (x.state === "done" || x.state === "backlog") continue;
    const add = (rule: WatchdogRule, detail: Trip["detail"] = {}) => trips.push({ ticketId: x.id, rule, detail: { ...detail, ...(holding.get(x.id) ? { holds: holding.get(x.id) } : {}) } });
    const since = x.stateChangedAt.getTime();
    const runs = (runsBy.get(x.id) ?? []).filter((r) => r.startedAt.getTime() <= t);
    const live = runs.some((r) => !r.endedAt || r.endedAt.getTime() > t);

    if (x.bounces > s.reviewBounces) add("review_loop", { bounces: x.bounces });

    // Rule 2: waiting on the owner's decision. No agent is chased; the owner is reminded.
    const holds = (holdsBy.get(x.id) ?? []).filter((h) => !h.resolved);
    const decision = holds.filter((h): h is Extract<SnapHold, { kind: "decision" }> => h.kind === "decision").sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())[0];
    if (decision) {
      const age = t - decision.openedAt.getTime();
      if (age >= s.ownerDecisionHours * H) add("owner_decision_waiting", { decisionId: decision.decisionId, idleMs: age, limitMs: s.ownerDecisionHours * H });
      continue;
    }
    // Rule 1: held by another ticket or an engagement. The holder is judged on its own.
    if (holds.length) continue;
    if (x.withOwner || x.assignedToOwner) continue;

    if (x.state === "ready" || x.state === "in_progress") {
      if (!x.assigneeAgentId) {
        if (t - since >= s.unassignedMinutes * 60_000) add("unassigned", { idleMs: t - since, limitMs: s.unassignedMinutes * 60_000 });
        continue;
      }
    }
    // Nobody is chased while a run is working on it: the clock is stopped.
    if (live) continue;

    if (x.state === "in_progress") {
      // A scheduled check (waiting on CI, a deploy) or a queued wake is a plan, not a stall.
      if (x.awaitingPlan || x.scheduled) continue;
      const mine = runs.filter((r) => r.agentId === x.assigneeAgentId);
      const last = mine.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
      // Rule 1 of the idle-capacity rules (BOS-659): the agent is idle on an in-progress ticket and nothing
      // is scheduled for it. Two shapes, both handed to the Scrum Master at the short limit:
      //   - it never ran on it (or every run it had was before it entered in-progress, so none is kept);
      //   - it picked it up and then let go: a run started just after the ticket moved (the scheduler's
      //     pickup) and has ended normally, nothing since. Its normal end used to fall through to the
      //     45-minute grace and the two-hour long rule, so half the slots sat empty for hours (BOS-659 live
      //     follow-up). A crash keeps its own rule and grace, because Boss Man's free recovery goes first; a
      //     run that straddles or precedes the move stays the long rules' shape, so one idle spell is one flag.
      if (!last) {
        const idle = t - since;
        if (idle >= s.idleAgentMinutes * 60_000) add("idle_agent", { idleMs: idle, limitMs: s.idleAgentMinutes * 60_000 });
        continue;
      }
      if (last.endedAt && !isCrash(last.outcome) && since < last.startedAt.getTime() && t - last.endedAt.getTime() < RUN_ENDED_GRACE_MS) {
        const idle = t - last.endedAt.getTime();
        if (idle >= s.idleAgentMinutes * 60_000) add("idle_agent", { idleMs: idle, limitMs: s.idleAgentMinutes * 60_000 });
        continue;
      }
      // Inside the grace after a run, Boss Man's own free fixes go first; nothing is flagged yet.
      if (last?.endedAt && t - last.endedAt.getTime() < RUN_ENDED_GRACE_MS) continue;
      if (last?.endedAt) {
        if (isCrash(last.outcome)) {
          add("run_crashed", { runId: last.id, runOutcome: last.outcome, idleMs: t - last.endedAt.getTime() });
          continue;
        }
        if (since < last.startedAt.getTime()) {
          add("run_ended_unmoved", { runId: last.id, runOutcome: last.outcome, idleMs: t - last.endedAt.getTime() });
          continue;
        }
      }
      const idle = t - since - covered(mine.map((r) => [r.startedAt.getTime(), (r.endedAt ?? now).getTime()]), since, t);
      if (idle >= s.inProgressHours * H) add("stale_in_progress", { idleMs: idle, limitMs: s.inProgressHours * H });
    } else if (x.state === "ready") {
      // Rule 2 of the idle-capacity rules (BOS-659): every ticket it waited on is done or cancelled (so
      // `holds` is empty by now), it is assigned, no run has ever started on it, and it has been free for
      // the short limit. Handed straight to the Scrum Master: the slots are free and this work could have
      // started. The short grace lets the scheduler start it first; a ticket made ready with no blocker was
      // never waiting to be started, so it is left to the missed-work sweep.
      if (!runs.length && x.unblockedAt) {
        const idle = t - Math.max(since, x.unblockedAt.getTime());
        if (idle >= s.idleAgentMinutes * 60_000) add("unstarted", { idleMs: idle, limitMs: s.idleAgentMinutes * 60_000 });
      }
    } else if (x.state === "review") {
      // Approved by everyone: the merge sweep owns it, and raises a merge card of its own if it can't land.
      if (x.mergeWaiting) continue;
      const idle = t - since - covered(runs.map((r) => [r.startedAt.getTime(), (r.endedAt ?? now).getTime()]), since, t);
      if (idle >= s.reviewHours * H) add("stale_review", { idleMs: idle, limitMs: s.reviewHours * H });
    } else if (x.state === "blocked") {
      // Rule 3: quiet until "blocked until" plus the grace; with no date, the normal limit.
      if (x.blockedUntil) {
        const at = x.blockedUntil.getTime() + s.blockedUntilGraceHours * H;
        if (t >= at) add("blocked_until_passed", { blockedUntil: x.blockedUntil.toISOString(), idleMs: t - x.blockedUntil.getTime(), limitMs: s.blockedUntilGraceHours * H });
        continue;
      }
      const idle = t - since - covered(runs.map((r) => [r.startedAt.getTime(), (r.endedAt ?? now).getTime()]), since, t);
      if (idle >= s.blockedHours * H) add("stale_blocked", { idleMs: idle, limitMs: s.blockedHours * H });
    }
  }
  return trips;
}

/** How long a handled flag stays quiet before it can be handed on again: the rule's own limit. */
export function ruleLimitMs(rule: WatchdogRule, s: WatchdogSettings) {
  switch (rule) {
    case "unassigned":
      return s.unassignedMinutes * 60_000;
    case "stale_review":
      return s.reviewHours * H;
    case "stale_blocked":
      return s.blockedHours * H;
    case "blocked_until_passed":
      return Math.max(s.blockedUntilGraceHours, 1) * H;
    case "owner_decision_waiting":
      return 24 * H;
    case "idle_agent":
    case "unstarted":
      // One hand-off per condition until it clears (BOS-659): nothing repeats this for a day; a run that
      // gets the agent going closes the flag on the next sweep.
      return BACKOFF_CAP_MS;
    case "review_loop":
      return s.reviewHours * H;
    default:
      return s.inProgressHours * H;
  }
}

/** The longest a repeat flag on the same ticket and rule is made to wait. */
export const BACKOFF_CAP_MS = 24 * H;

/**
 * How long a flag waits after a hand-off before it can be handed on again. `steps` is how many
 * hand-offs in a row nothing happened on the ticket since the last one: the rule's limit, then
 * twice that, then four times, capped at 24 hours (or the limit itself, if that is longer).
 */
export function backoffGapMs(rule: WatchdogRule, s: WatchdogSettings, steps: number) {
  const limit = ruleLimitMs(rule, s);
  return Math.min(limit * 2 ** steps, Math.max(limit, BACKOFF_CAP_MS));
}
