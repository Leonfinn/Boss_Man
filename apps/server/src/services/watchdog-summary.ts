// The Scrum Master's daily summary to the owner (BOS-60), written as a pure function of what the
// watchdog saw, so the "only on days something happened" rule and the wording are testable.
import { WATCHDOG_RULE_LABEL, type WatchdogRule } from "@boss-man/shared";

const H = 3_600_000;

export type SummaryInput = {
  now: Date;
  /** Flags the watchdog opened since the last summary, and how many of those have since cleared. */
  caught: number;
  fixed: number;
  /** Logged actions since the last summary, by kind (sweep wakes, reminders and the summary itself excluded). */
  actions: Record<string, number>;
  /** Problems still open, and who each waits on. */
  open: Array<{ ref: string; title: string; rule: WatchdogRule; waitingOn: string; openedAt: Date }>;
  /** Record-only mode (BOS-166): the actions below were rehearsals, so they are reported as not sent. */
  recordOnly?: boolean;
  /** Open owner decisions that hold tickets back. */
  decisions: Array<{ question: string; blocks: string[]; askedAt: Date }>;
};

export type Summary = { title: string; body: string; stuck: number; oldestRef: string | null };

export const age = (ms: number) => (ms >= 2 * 24 * H ? `${Math.floor(ms / (24 * H))} days` : ms >= 2 * H ? `${Math.floor(ms / H)} hours` : `${Math.max(1, Math.round(ms / 60_000))} minutes`);

const ACTION_WORDS: Record<string, string> = {
  nudge: "nudged",
  assign: "assigned",
  rewake: "re-woken",
  chase_review: "review chases",
  snooze: "snoozed",
  escalate: "escalated",
  auto_escalate: "escalated",
  raise_decision: "owner decisions raised",
};

/** Rehearsal entries (BOS-166), counted apart from real actions and always marked as not sent. */
const RECORD_WORDS: Record<string, string> = {
  record_sweep_wake: "Scrum Master wakes",
  record_owner_reminder: "owner reminders",
  record_auto_escalate: "escalations to the CEO",
  record_urgent_page: "pages to you about a decision",
  record_alert_skip: "Boss Man alerts passed up the ladder",
  record_quota_held_alert: "CEO alerts about work held by the usage limit",
};

/** Null on a day nothing happened: no new problems, no actions, nothing cleared. Record-only runs always report. */
export function buildSummary(i: SummaryInput): Summary | null {
  const acted = Object.entries(i.actions).filter(([k, n]) => n > 0 && ACTION_WORDS[k]);
  const recorded = Object.entries(i.actions).filter(([k, n]) => n > 0 && RECORD_WORDS[k]);
  if (!i.caught && !i.fixed && !acted.length && !recorded.length && !i.recordOnly) return null;

  // Owner decisions are the owner's to answer, not "stuck" work, so they stay out of the headline.
  const stuck = i.open.filter((o) => o.rule !== "owner_decision_waiting").sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  const oldest = stuck[0];
  const headline = stuck.length ? `${stuck.length} ticket${stuck.length === 1 ? " is" : "s are"} stuck past the limit; the oldest is ${oldest!.ref}, for ${age(i.now.getTime() - oldest!.openedAt.getTime())}.` : "No tickets are stuck past their limit.";

  const lines = [headline, ""];
  if (i.recordOnly) lines.push("Record only: the watchdog is rehearsing. Everything below was written down, and nothing was sent to anyone.");
  lines.push(`Caught ${i.caught} problem${i.caught === 1 ? "" : "s"}; ${i.fixed} cleared since.`);
  if (acted.length) lines.push(`Actions: ${acted.map(([k, n]) => `${n} ${ACTION_WORDS[k]}`).join(", ")}.`);
  if (recorded.length) lines.push(`Would have done (not sent): ${recorded.map(([k, n]) => `${n} ${RECORD_WORDS[k]}`).join(", ")}.`);
  if (stuck.length) {
    lines.push("", "Still open:");
    for (const o of stuck.slice(0, 10)) lines.push(`- ${o.ref} "${o.title}": ${WATCHDOG_RULE_LABEL[o.rule]}; waiting on ${o.waitingOn}`);
    if (stuck.length > 10) lines.push(`- and ${stuck.length - 10} more`);
  }
  if (i.decisions.length) {
    lines.push("", "Waiting on you:");
    for (const d of i.decisions.slice(0, 10)) lines.push(`- "${d.question}" holds ${d.blocks.join(", ")}; asked ${age(i.now.getTime() - d.askedAt.getTime())} ago`);
  }
  return { title: "Scrum Master daily summary", body: lines.join("\n"), stuck: stuck.length, oldestRef: oldest?.ref ?? null };
}
