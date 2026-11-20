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

const WAKE_TABLE = {
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
  "staging deploy finished": "waiting",
  "ceo reply": "waiting",
  // BOS-2058: the CEO is told an update is late or gave up. Runs in the reply lane and passes the update's own hold.
  "update alert": "waiting",
  // Priority watch (BOS-1514): the CEO is told an urgent ticket has no next step under way. Never dropped.
  "priority watch": "waiting",
  // Merge stall (BOS-1515): the CEO is told the merge train has an empty seat or no landing while tickets wait. Never dropped.
  "merge line stalled": "waiting",
  // Idle check capacity (R46, BOS-1814): a free check slot has not taken a queued job for 5 minutes. The CEO must hear it. Never dropped.
  "idle check slot": "waiting",
  // Line holder sent back (BOS-1669): a ticket others wait on to merge failed the gate; the CEO may have promised the owner word.
  "line holder sent back": "waiting",
  // Line holder stuck (R40, BOS-1685): a main fix has held the merge line over 2 hours; the CEO picks quarantine or revert, once per fix.
  "line holder stuck": "waiting",
  // The start brake has no limit and the merge line has grown for an hour (R47): the CEO hears once per stretch. Never dropped.
  "merge start brake off": "waiting",
  // Nothing can start (BOS-1662): free slots and idle agents, but every open ticket waits on another. The CEO must hear it.
  "nothing startable": "waiting",
  // A planned or urgent ticket was moved off its plan or backwards by someone else (BOS-1509). The CEO must hear it.
  "ticket moved off plan": "waiting",
  // A ticket parked by date three times in a row with no link (BOS-1679): the CEO must hear it. Never dropped.
  "parked by date again and again": "waiting",
  // A split-out after-merge check ticket closed and its result was written on this ticket (BOS-1794). Never dropped.
  "after-merge check reported": "waiting",
  // The owner's note on a card nobody watches (a Boss Man card, or one whose ticket is done) goes to the CEO (BOS-2077). Never dropped.
  "owner hand-back": "waiting",
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
  // The GitHub watcher filed new notes (BOS-1393): one wake per pass, never dropped, merged while it waits.
  "github feedback": "scheduled",
  // A GitHub post that looks like a security report goes to the CEO at once (BOS-1393).
  "github security": "scheduled",
  // The GitHub watcher opened a ticket for a Dependabot or secret-scanning alert, or can't read them (BOS-1929): once per alert, never dropped.
  "github security alert": "scheduled",
  "github secret alert": "scheduled",
  "github alerts unreadable": "scheduled",
  // The runner-update answer is "can't tell" (BOS-1648): a fault the CEO must hear, once per cause, never dropped.
  "runner update: can't tell": "scheduled",
  // The live commit still can't be placed after the missed-merge sweep (BOS-1645): once per commit, never dropped.
  "live commit not placed": "scheduled",
  // The owner's approved server update left the live commit unchanged (BOS-1805): once per deploy, never dropped.
  "deploy left the server unchanged": "scheduled",
  // The nightly secrets pass found a key-shaped string on main, or one whose closed ticket is still there (BOS-1932). Never dropped.
  "secret scan": "scheduled",
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
} satisfies Record<string, WakeClass>;

export const WAKE_CLASS: Record<string, WakeClass> = WAKE_TABLE;
export type WakeReason = keyof typeof WAKE_TABLE;

/**
 * BOS-2058 (rule: an alert about a wait is never held by it). While a server or runner update holds new starts, every
 * queued wake is held with "update pending" except the owner's chat and the CEO's one-off reply (while work still runs),
 * and the reasons listed here: wakes that REPORT on an update. Today that is "update alert" (scheduler.ts
 * UPDATE_ALERT_REASON), which is how every "update is late" or "update gave up" note reaches the CEO, in the reply lane.
 * The generic "ceo reply" is NOT listed: routine replies stay held once nothing else runs (DR-048 A). A reason not listed is held, the safe default (work started now would only push
 * the swap back). Typed against the table above, so a name that is not a wake reason fails typecheck, and
 * update-waits-guard.test.ts starts each of them while a hold is on. A run one of these starts is the "update alert"
 * class: no wait counts it, so it cannot hold the update it reports on.
 */
export const PASSES_UPDATE_HOLD: ReadonlyArray<WakeReason> = ["update alert"];
export const duringUpdate = (reason: string): "held" | "passes" => ((PASSES_UPDATE_HOLD as readonly string[]).includes(reason) ? "passes" : "held");

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
