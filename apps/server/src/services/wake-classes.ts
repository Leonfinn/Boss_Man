// Every reason a wake can have belongs to exactly one class, and the class decides how the
// scheduler treats it (DR-002). The table is the one place to say so: a new reason that isn't
// here fails wake-classes.test.ts, instead of quietly falling under someone else's cap.
//
//  - waiting:   a person or a card is waiting on this run. Never dropped; loop protection raises an alert instead.
//  - scheduled: Boss Man set it up itself. Never dropped; a newer one replaces an unstarted one; ages in the queue.
//  - agent:     started by an agent's own action. Rate-limited when it has no ticket; ages in the queue like scheduled (DR-031).
//
// The reasons are written out here rather than imported from the modules that define them,
// because those modules import the scheduler; the test checks each constant against this table.
export type WakeClass = "waiting" | "scheduled" | "agent";

export const WAKE_CLASS: Record<string, WakeClass> = {
  // Someone is waiting.
  decision: "waiting",
  alert: "waiting",
  "review requested": "waiting",
  owner_chat: "waiting",
  "woken by owner": "waiting",
  message: "waiting",
  "rule request": "waiting",
  "decision answered": "waiting",
  "deploy approved": "waiting",
  "deploy rejected": "waiting",
  "ceo reply": "waiting",
  // Priority watch (BOS-1514): the CEO is told an urgent ticket has no next step under way. Never dropped.
  "priority watch": "waiting",
  // Merge stall (BOS-1515): the CEO is told the merge train has an empty seat or no landing while tickets wait. Never dropped.
  "merge line stalled": "waiting",
  // Scheduled by Boss Man.
  "ticket watch": "scheduled",
  "tree stopped": "scheduled",
  "check due": "scheduled",
  "missed work": "scheduled",
  "urgent idle": "scheduled",
  "idle slot": "scheduled",
  "idle agents": "scheduled",
  "spare capacity": "scheduled",
  "status check": "scheduled",
  resume: "scheduled",
  watchdog: "scheduled",
  "watchdog re-wake": "scheduled",
  "watchdog escalation": "scheduled",
  retro: "scheduled",
  "ci passed": "scheduled",
  check_result: "scheduled",
  "checking an old card": "scheduled",
  "live release": "scheduled",
  "review hold ready": "scheduled",
  // The merge queue tells the CEO a card holding a merge looks stale (BOS-1078).
  "merge held by a stale card": "scheduled",
  // Started by agents.
  nudge: "agent",
  chased: "agent",
  feedback: "agent",
  "skill decided": "agent",
  "wiki upkeep": "agent",
  unblocked: "agent",
  assigned: "agent",
  engagement: "agent",
  "note request": "agent",
};

/** A reason nobody classified is treated as the agent class, today's rate-limited behaviour. */
export const wakeClass = (reason: string): WakeClass => WAKE_CLASS[reason] ?? "agent";

export const reasonsOfClass = (c: WakeClass) => Object.keys(WAKE_CLASS).filter((r) => WAKE_CLASS[r] === c);

/** What wake() and notify() say happened to the wake. */
export type WakeOutcome = "queued" | "deferred" | "steered" | "merged" | "dropped";

/** Queue ageing for the scheduled and agent classes: +1 rank for every 15 minutes waited. */
export const AGE_STEP_MS = 15 * 60_000;

/**
 * Ageing stops at this rank (BOS-579, DR-031): above every stored priority, and reached by a
 * priority-2 wake after 2 hours. Once wakes reach it they are equal, and the oldest goes first, so
 * no class or priority can keep a wake waiting for ever, however much newer work keeps arriving.
 */
export const AGE_RANK_CAP = 10;

/**
 * A queued wake's rank (DR-002, DR-031). A wake someone is waiting on keeps its priority: its class
 * already goes first. Scheduled and agent wakes both gain 1 for every 15 minutes waited, up to the
 * cap; a stored priority above the cap is kept as it is.
 */
export function agedRank(priority: number, cls: WakeClass, waitedMs: number): number {
  if (cls === "waiting") return priority;
  const steps = Math.max(0, Math.floor(waitedMs / AGE_STEP_MS));
  return Math.max(priority, Math.min(priority + steps, AGE_RANK_CAP));
}
