// Every reason a wake can have belongs to exactly one class, and the class decides how the
// scheduler treats it (DR-002). The table is the one place to say so: a new reason that isn't
// here fails wake-classes.test.ts, instead of quietly falling under someone else's cap.
//
//  - waiting:   a person or a card is waiting on this run. Never dropped; loop protection raises an alert instead.
//  - scheduled: Boss Man set it up itself. Never dropped; a newer one replaces an unstarted one; ages in the queue.
//  - agent:     started by an agent's own action. Rate-limited when it has no ticket.
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
  // Scheduled by Boss Man.
  "ticket watch": "scheduled",
  "tree stopped": "scheduled",
  "check due": "scheduled",
  "missed work": "scheduled",
  "status check": "scheduled",
  resume: "scheduled",
  watchdog: "scheduled",
  "watchdog re-wake": "scheduled",
  "watchdog escalation": "scheduled",
  retro: "scheduled",
  "ci passed": "scheduled",
  "checking an old card": "scheduled",
  "live release": "scheduled",
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

/** Queue ageing for the scheduled class: +1 priority for every 15 minutes waited. */
export const AGE_STEP_MS = 15 * 60_000;
