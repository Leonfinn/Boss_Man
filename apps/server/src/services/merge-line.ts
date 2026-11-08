// The merge line's timeline (BOS-769): when approved work was approved, checked, held and merged, so a jam's
// length can be measured afterwards (BOS-590's "how we will know it worked"). Each moment is one activity row
// of kind "merge_line" with the facts in `detail`; there is no screen, the rows are read directly:
//
//   select at, ticket_id, detail from activity where kind = 'merge_line' order by ticket_id, at;
//
// Events, in `detail.event`:
//   approved       the approval that sent it to the line (by, reviewerAgentId)
//   attempt        a merge attempt started (by: who or what started it; retries and sweeps count)
//   check_queued   a merge check started waiting for a slot (check, way: gate | merged | queue, jobId)
//   check_started  it got a slot and started running
//   check_ended    it ended: passed true/false, or null when it never finished (killed, runner gone, stuck)
//   hold_started   the line held it: reason carried | sign_off | card | host | unchecked, with carried/note/decisionId
//   hold_ended     the hold ended (reason, since, heldMs); written by the next event that moves the line (a check,
//                  a merge, leaving, another hold), so a hold always closes. A retry ("attempt") or a repeat
//                  approval that is held again doesn't end it, so one jam reads as one hold, not many short ones.
//   merged         it merged (commit; null when there was nothing to merge)
//   left           it left review without merging (to: the state it moved to)
//
// Design notes. The open hold is found from the ticket's last merge_line row (a partial index keeps that
// lookup off the company-wide range), so it survives a server restart. Recording never fails the merge it
// describes: a write error is swallowed. The rows carry no agent, so the brief and "what did this run do"
// readers that count an agent's activity never see them; the brief also skips the kind outright.
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activity } from "../db/schema.js";
import { record } from "./activity.js";

export const MERGE_LINE_KIND = "merge_line";

export type HoldReason = "carried" | "sign_off" | "card" | "host" | "unchecked";
export type CheckWay = "gate" | "merged" | "queue";

export type MergeLineEvent =
  | { event: "approved"; by: string; reviewerAgentId?: string | null }
  | { event: "attempt"; by: string }
  | { event: "check_queued"; check: string; way: CheckWay; jobId?: string; reused?: boolean }
  | { event: "check_started"; check: string; way: CheckWay; jobId?: string }
  | { event: "check_ended"; check: string; way: CheckWay; jobId?: string; passed: boolean | null; why?: string }
  | { event: "hold_started"; reason: HoldReason; note?: string; carried?: Array<{ ticketId: string; title: string }>; decisionId?: string | null }
  | { event: "hold_ended"; reason: HoldReason; since: string; heldMs: number }
  | { event: "merged"; commit: string | null }
  | { event: "left"; to: string };

const SUMMARY: { [K in MergeLineEvent["event"]]: (e: Extract<MergeLineEvent, { event: K }>) => string } = {
  approved: (e) => `Merge line: approved by ${e.by}`,
  attempt: (e) => `Merge line: merge attempt started (${e.by})`,
  check_queued: (e) => `Merge line: check waiting for a slot${e.reused ? " (reused an earlier result)" : ""}`,
  check_started: () => "Merge line: check started",
  check_ended: (e) => `Merge line: check ${e.passed === true ? "passed" : e.passed === false ? "failed" : "did not finish"}`,
  hold_started: (e) => `Merge line: held (${e.reason})${e.note ? `: ${e.note}` : ""}`,
  hold_ended: (e) => `Merge line: hold (${e.reason}) ended after ${Math.round(e.heldMs / 60_000)} min`,
  merged: (e) => `Merge line: merged${e.commit ? ` as ${e.commit.slice(0, 12)}` : ""}`,
  left: (e) => `Merge line: left without merging (moved to ${e.to})`,
};

const summaryOf = (e: MergeLineEvent) => (SUMMARY[e.event] as (x: MergeLineEvent) => string)(e);

/** Events that say the line is still where it was: a retry or a repeat approval while held does not end the hold. */
const PASSIVE = ["approved", "attempt"];

/** The ticket's last merge_line row (or its last one that isn't passive), through the partial index on (ticket_id, at). */
async function lastEvent(db: Db, ticketId: string, skipPassive = false): Promise<{ at: Date; detail: MergeLineEvent } | null> {
  const [row] = await db
    .select({ at: activity.at, detail: activity.detail })
    .from(activity)
    .where(and(eq(activity.ticketId, ticketId), eq(activity.kind, MERGE_LINE_KIND), skipPassive ? notInArray(sql`${activity.detail}->>'event'`, PASSIVE) : undefined))
    .orderBy(desc(activity.at))
    .limit(1);
  return row ? { at: row.at, detail: row.detail as unknown as MergeLineEvent } : null;
}

const sameHold = (a: Extract<MergeLineEvent, { event: "hold_started" }>, b: Extract<MergeLineEvent, { event: "hold_started" }>) =>
  a.reason === b.reason &&
  (a.carried ?? []).map((c) => c.ticketId).sort().join(",") === (b.carried ?? []).map((c) => c.ticketId).sort().join(",");

/**
 * Records one moment of a ticket's pass through the merge line. Closes an open hold first when anything else
 * happens. A repeat of the hold already open is not written again, and "left" (and a hold) is only written for
 * a ticket that is in the line, so moving an unapproved ticket out of review leaves no row. Never throws.
 */
export async function lineEvent(db: Db, t: { id: string; companyId: string }, e: MergeLineEvent, at: Date = new Date()): Promise<void> {
  try {
    const prev = (await lastEvent(db, t.id))?.detail;
    const inLine = !!prev && prev.event !== "merged" && prev.event !== "left";
    if ((e.event === "left" || e.event === "hold_started") && !inLine) return;
    if (e.event === "merged" && prev?.event === "merged") return;
    // The hold still open, if any: the last row that isn't a retry or a repeat approval.
    const last = inLine && !PASSIVE.includes(e.event) ? await lastEvent(db, t.id, true) : null;
    const open = last?.detail.event === "hold_started" ? last.detail : null;
    if (last && open) {
      if (e.event === "hold_started" && sameHold(open, e)) return;
      // Never before the hold began: a check row stamped from a queue job's own time can be older.
      const end = at < last.at ? last.at : at;
      const ended: MergeLineEvent = { event: "hold_ended", reason: open.reason, since: last.at.toISOString(), heldMs: end.getTime() - last.at.getTime() };
      await record(db, { companyId: t.companyId, ticketId: t.id, kind: MERGE_LINE_KIND, summary: summaryOf(ended), detail: ended, at: end });
      // One millisecond later, so "the last row" is never a tie between the two.
      at = new Date(end.getTime() + 1);
    }
    await record(db, { companyId: t.companyId, ticketId: t.id, kind: MERGE_LINE_KIND, summary: summaryOf(e), detail: e as unknown as Record<string, unknown>, at });
  } catch {
    // A record of the line must never stop the line.
  }
}
