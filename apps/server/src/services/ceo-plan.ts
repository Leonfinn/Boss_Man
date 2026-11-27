// The CEO's plan on a ticket (BOS-1509, T13): how it is shown, and what a move away from it says and does.
// Pure helpers only; set_ticket_state does the writes and the CEO wake.
import { actionClaim } from "@boss-man/shared";

type PlanFields = { ceoPlan: string | null; ceoPlanDeadline: Date | null };

const utc = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

/** "CEO plan (due 2026-11-16 12:00 UTC): ..." for a ticket that has one; "past" once the deadline has gone. */
export function ceoPlanText(t: PlanFields, now: Date, max = 300): string | null {
  const plan = t.ceoPlan?.trim();
  if (!plan) return null;
  const due = t.ceoPlanDeadline ? `due ${utc(t.ceoPlanDeadline)} UTC${t.ceoPlanDeadline.getTime() <= now.getTime() ? ", passed" : ""}` : "no deadline";
  return `CEO plan (${due}): ${plan.length > max ? `${plan.slice(0, max - 1)}…` : plan}`;
}

/** The plan only while its deadline is still ahead (an expired plan no longer holds the ticket). */
export const unexpiredPlan = (t: PlanFields, now: Date): boolean => !!t.ceoPlan?.trim() && !!t.ceoPlanDeadline && t.ceoPlanDeadline.getTime() > now.getTime();

/** How long after a plan's deadline the stuck-type alerts stay quiet (BOS-612). */
export const PLAN_GRACE_MS = 30 * 60_000;

/** True while a CEO plan's deadline plus the grace is still ahead: the looks-stuck and parked-by-date alerts stay quiet (BOS-2402). */
export const planHoldsAlerts = (t: PlanFields, now: Date, graceMs: number = PLAN_GRACE_MS): boolean => !!t.ceoPlanDeadline && now.getTime() < t.ceoPlanDeadline.getTime() + graceMs;

/** Moves that leave a plan: out to Blocked or Backlog, or back from In progress to Ready. */
export const leavesPlan = (from: string, to: string): boolean => from !== to && (to === "blocked" || to === "backlog" || (from === "in_progress" && to === "ready"));

/** Moves backwards on an urgent ticket. */
export const urgentBackwards = (from: string, to: string): boolean => (from === "review" && (to === "in_progress" || to === "blocked" || to === "backlog")) || (from === "in_progress" && (to === "ready" || to === "backlog"));

/** The refusal for Review -> Blocked when the only wait is another ticket's merge. */
export const REVIEW_BLOCKED_REFUSAL =
  "Leave it in review. A ticket that passed review and only waits for another ticket's merge waits there as \"Passed, held\" and merges by itself once that ticket merges. Moving it to Blocked would drop it out of the merge line.";

/** The warning for In progress -> Blocked on a ticket that has been through review, when the wait is another ticket. */
export const IN_PROGRESS_BLOCKED_WARNING =
  "Heads up: this ticket has already been through review. If its work is finished and it only waits for another ticket's merge, move it back to review instead: it waits there as \"Passed, held\" and merges by itself once that ticket merges. In Blocked it is out of the merge line.";

/**
 * The mover's reply line, when they left an unexpired plan. Who acts on it comes from actionClaim (BOS-2737): the time
 * the CEO's wake was actually sent, or that nobody was alerted. It used to say "The CEO has been told" whenever the
 * mover wasn't the CEO, even when no wake went out (no CEO, or no wake hook).
 */
export function planMoveWarning(plan: string, from: string, to: string, byCeo: boolean, ceoWokenAt: Date | null): string {
  const who = byCeo ? "You are the CEO, so nobody else was told." : actionClaim({ who: "The CEO", raisedAt: ceoWokenAt, live: false }).text;
  return `\n\nHeads up: the CEO set a plan for this ticket that has not expired yet, and ${from} -> ${to} leaves it. ${plan} ${who}`;
}

/** The note that wakes the CEO. */
export function ceoMoveNote(input: { title: string; ref: string | null; from: string; to: string; mover: string; summary: string | null; plan: string | null; urgent: boolean }): string {
  const what = [input.plan ? "left its plan" : null, input.urgent ? "an urgent ticket went backwards" : null].filter(Boolean).join("; ");
  return [`${input.ref ? `${input.ref} ` : ""}"${input.title}" moved ${input.from} -> ${input.to} by ${input.mover} (${what}).`, input.plan, input.summary ? `${input.mover}'s summary: ${input.summary}` : null, "Decide whether to leave it or put it back on the plan."].filter(Boolean).join("\n");
}
