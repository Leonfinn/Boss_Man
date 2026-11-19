// The merge line's timeline (BOS-769): when approved work was approved, checked, held and merged, so a jam's
// length can be measured afterwards (BOS-590's "how we will know it worked"). Each moment is one activity row
// of kind "merge_line" with the facts in `detail`; there is no screen. Agents read the rows with the read-only
// `merge_line_records` tool (BOS-1210, mcp-merge-line.ts); on the database directly:
//
//   select at, ticket_id, detail from activity where kind = 'merge_line' order by ticket_id, at;
//
// Events, in `detail.event`:
//   approved       the approval that sent it to the line (by, reviewerAgentId)
//   attempt        a merge attempt started (by: who or what started it; retries and sweeps count)
//   check_queued   a merge check started waiting for a slot (check, way: gate | merged | queue, jobId)
//   check_started  it got a slot and started running
//   check_ended    it ended: passed true/false, or null when it never finished (killed, runner gone, stuck)
//   restacked      merge train (BOS-1366): prepared again on a new base (why: ahead_left | ahead_changed | main_moved)
//   rerun          merge train: a failed check that stood ran once more on the same tree (passed: true is a flaky pass)
//   hold_started   the line held it: hold carried | sign_off | card | host | unchecked | waits_on | train (waiting for a seat)
//                  | turn (BOS-1762: waiting to push while another ticket has the landing turn), with carried/note/decisionId
//   hold_ended     the hold ended (hold, since, heldMs); written by the next event that moves the line (a check,
//                  a merge, leaving, another hold), so a hold always closes. A retry ("attempt") or a repeat
//                  approval that is held again doesn't end it, so one jam reads as one hold, not many short ones.
//   merged         it merged (commit; null when there was nothing to merge)
//   attempt_failed a merge attempt did not land (reason: check_failed | landing_refused | main_moved | conflict |
//                  lock_timeout | restart | gate_fault; jobId; note). BOS-1461: server_status counts the last hour
//                  by reason, and three of one reason in 30 minutes raise one CEO alert (merge-failures.ts).
//   train_clash    merge train (BOS-1515): on ahead = held to land on main alone (with: the members it clashed with, files),
//                  on main = a trial merge on main clashed after main moved, so it is sent back at once (files)
//   carried_across BOS-1762: its passed merge landed on a main that moved since it was tested, because main's new
//                  commits touched none of its files (from, to, commits, files: how many files main changed)
//   rebuilt        BOS-1762: main moved after its check and GitHub passed, so it is built and tested again
//                  (rebuilds: how many times this merge; why/files: why it couldn't be carried, when it was asked)
//   refreshed      BOS-1820: with GitHub CI gating, main moved while its check waited for a slot in a way a pass couldn't
//                  be carried across, so the queued job took the new merge (and a new GitHub run) before it started
//                  (why/files: why no carry; refreshes: how many times this attempt)
//   landing_turn   BOS-1762: its landing turn was taken | queued | ended | expired (rebuilds, capMin)
//   left           it left review without merging (to: the state it moved to)
//   takeover       a server took charge (by: the cause, see TakeoverCause; commit: the live commit). One row per
//                  company per takeover, with ticket_id null, written whether or not a merge is waiting; the
//                  "attempt" rows it causes follow it in time (BOS-1399).
//
// The hold's reason is in `hold`, not `reason`: wake-classes.test reads every `reason: "..."` in the source
// as a wake reason.
//
// Design notes. The open hold is found from the ticket's last merge_line row (a partial index keeps that
// lookup off the company-wide range), so it survives a server restart. Recording never fails the merge it
// describes: a write error is swallowed. The rows carry no agent, so the brief and "what did this run do"
// readers that count an agent's activity never see them; the brief also skips the kind outright.
import { and, desc, eq, gte, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activity, companies, settings } from "../db/schema.js";
import { record } from "./activity.js";

export const MERGE_LINE_KIND = "merge_line";

export type HoldReason = "carried" | "sign_off" | "card" | "host" | "unchecked" | "waits_on" | "train" | "turn";
export type CheckWay = "gate" | "merged" | "queue";

export type MergeLineEvent =
  | { event: "approved"; by: string; reviewerAgentId?: string | null }
  | { event: "attempt"; by: string }
  | { event: "check_queued"; check: string; way: CheckWay; jobId?: string; reused?: boolean; train?: { place: number; ahead: number } }
  /** Merge train (BOS-1366): prepared again on a new base. ahead_left / ahead_changed / main_moved. */
  | { event: "restacked"; why: "ahead_left" | "ahead_changed" | "main_moved" | "cap"; restacks: number }
  /** Merge train: a failed check that stood got its one re-run on the same tree; `passed` says how the re-run went (a flaky pass). */
  | { event: "rerun"; check: string; passed: boolean | null; failedJobId?: string }
  /** ranOn (BOS-1435): "company runner" or the check worker's name, for a queued check. */
  | { event: "check_started"; check: string; way: CheckWay; jobId?: string; ranOn?: string }
  | { event: "check_ended"; check: string; way: CheckWay; jobId?: string; passed: boolean | null; why?: string }
  | { event: "hold_started"; hold: HoldReason; note?: string; carried?: Array<{ ticketId: string; title: string }>; decisionId?: string | null }
  | { event: "hold_ended"; hold: HoldReason; since: string; heldMs: number }
  | { event: "merged"; commit: string | null }
  /** BOS-1461: a merge attempt that did not land, with why (`reason`) and the check job it was about, when there is one. */
  | { event: "attempt_failed"; reason: FailReason; jobId?: string; note?: string }
  /**
   * BOS-1515: a merge-train clash. on "ahead": it didn't merge cleanly on the members ahead (`with`), so it waits to land on main
   * alone (action land_alone). on "main": a trial merge on main clashed after main moved, so it goes back now (action sent_back);
   * `with` then names the tickets it was held alone for, if any. `files` is capped at TRAIN_CLASH_FILES.
   */
  | { event: "train_clash"; on: "ahead" | "main"; with: Array<{ ticketId: string; ref: string | null; title: string }>; files: string[]; fileCount?: number; action: "land_alone" | "sent_back" }
  | { event: "left"; to: string }
  | { event: "takeover"; by: TakeoverCause; commit: string | null }
  /** BOS-1762: landed on a moved main without a new test; main's `commits` new commits touched `files` files, none of its own. */
  | { event: "carried_across"; from: string; to: string; commits: number; files: number }
  /** BOS-1762: main moved after both passed, so the merge is built and tested again; `why`/`files`: why no carry. */
  | { event: "rebuilt"; rebuilds: number; why?: string; files?: string[] }
  /** BOS-1820: main moved while its check still waited for a slot, in a way a pass couldn't be carried across, so the queued job took the new merge first (place kept). */
  | { event: "refreshed"; why: string; files?: string[]; refreshes: number }
  | { event: "landing_turn"; action: "taken" | "queued" | "ended" | "expired"; rebuilds?: number; capMin?: number };

/**
 * Why a server took charge of the merge line (BOS-1399). A restart and a crash look the same from inside, so
 * both are "restart".
 *   deploy             first start of this process, on a different commit from the one that last took charge
 *   restart            first start of this process, on the same commit (plain restart or crash recovery)
 *   deployer_switch    the host deployer promoted a standby copy (SIGUSR2)
 *   standby_promotion  the lock came free and this copy, already running, won it
 */
export type TakeoverCause = "deploy" | "restart" | "deployer_switch" | "standby_promotion";

const LAST_COMMIT_KEY = "merge_line_last_takeover_commit";

/**
 * Works out the cause from what the process knows, and remembers the commit for the next takeover. `first` is
 * true for this process's first promotion, `signalled` when SIGUSR2 (the deployer's switch) asked for it.
 */
export async function takeoverCause(db: Db, p: { first: boolean; signalled: boolean; commit: string | null }): Promise<TakeoverCause> {
  let before: unknown = null;
  try {
    before = (await db.select({ value: settings.value }).from(settings).where(eq(settings.key, LAST_COMMIT_KEY)))[0]?.value ?? null;
    await db.insert(settings).values({ key: LAST_COMMIT_KEY, value: p.commit }).onConflictDoUpdate({ target: settings.key, set: { value: p.commit } });
  } catch {
    // The cause is a note; never stop a takeover for it.
  }
  if (p.signalled) return "deployer_switch";
  if (!p.first) return "standby_promotion";
  return before !== null && p.commit !== null && before !== p.commit ? "deploy" : "restart";
}

/**
 * Writes one "takeover" row for each company, with no ticket, so a takeover shows in the records even when no
 * merge is waiting. Never throws: a record of the line must never stop the line.
 */
export async function recordTakeover(db: Db, t: { cause: TakeoverCause; commit: string | null }, at: Date = new Date()): Promise<void> {
  try {
    const e: MergeLineEvent = { event: "takeover", by: t.cause, commit: t.commit };
    for (const c of await db.select({ id: companies.id }).from(companies)) {
      await record(db, { companyId: c.id, ticketId: null, kind: MERGE_LINE_KIND, summary: summaryOf(e), detail: e as unknown as Record<string, unknown>, at });
    }
  } catch {
    // see above
  }
}

/** At most this many files are kept on a train_clash row (the count says how many there were). */
export const TRAIN_CLASH_FILES = 30;

/** "BOS-1471 in 7 files (a.ts, b.ts, c.ts, …)": the clash in words, for the record, the merge queue and the stall alarm. */
export function clashWords(withRefs: string[], files: string[], total = files.length): string {
  const who = withRefs.length ? withRefs.join(", ") : "the tickets ahead";
  const shown = files.slice(0, 3).join(", ");
  const list = shown ? ` (${shown}${total > 3 ? ", …" : ""})` : "";
  return `${who}${total ? ` in ${total} file${total === 1 ? "" : "s"}${list}` : ""}`;
}

/** Why a merge attempt did not land (BOS-1461). */
export const FAIL_REASONS = ["check_failed", "landing_refused", "main_moved", "conflict", "lock_timeout", "restart", "gate_fault"] as const;
export type FailReason = (typeof FAIL_REASONS)[number];
export const FAIL_REASON_TEXT: Record<FailReason, string> = {
  check_failed: "the merge check failed",
  landing_refused: "landing was refused (uncommitted work or a migration problem)",
  main_moved: "main moved while the merge ran",
  conflict: "the branch conflicts with main",
  lock_timeout: "the merge check gave up waiting for a check slot",
  restart: "the runner restarted or went away under the merge",
  gate_fault: "the merge gate itself failed (check stuck or an error)",
};

const SUMMARY: { [K in MergeLineEvent["event"]]: (e: Extract<MergeLineEvent, { event: K }>) => string } = {
  approved: (e) => `Merge line: approved by ${e.by}`,
  attempt: (e) => `Merge line: merge attempt started (${e.by})`,
  check_queued: (e) => `Merge line: check waiting for a slot${e.reused ? " (reused an earlier result)" : ""}${e.train ? ` (merge train, place ${e.train.place})` : ""}`,
  restacked: (e) =>
    e.why === "cap"
      ? `Merge line: left the merge train after ${e.restacks} restacks; it tries again later`
      : `Merge line: merge train restacked (${e.why === "main_moved" ? "main moved outside the train" : e.why === "ahead_left" ? "a ticket ahead left the train" : "a ticket ahead was prepared again"})`,
  rerun: (e) => `Merge line: failed check run once more${e.passed === true ? ": passed (a flaky failure)" : e.passed === false ? ": failed again" : ""}`,
  check_started: () => "Merge line: check started",
  check_ended: (e) => `Merge line: check ${e.passed === true ? "passed" : e.passed === false ? "failed" : "did not finish"}`,
  hold_started: (e) => (e.hold === "turn" ? `Merge line: waiting behind another ticket's landing turn${e.note ? `: ${e.note}` : ""}` : `Merge line: held (${e.hold})${e.note ? `: ${e.note}` : ""}`),
  hold_ended: (e) => `Merge line: hold (${e.hold}) ended after ${Math.round(e.heldMs / 60_000)} min`,
  merged: (e) => `Merge line: merged${e.commit ? ` as ${e.commit.slice(0, 12)}` : ""}`,
  attempt_failed: (e) => `Merge line: merge attempt failed (${e.reason})${e.note ? `: ${e.note}` : ""}`,
  train_clash: (e) => {
    const names = e.with.map((w) => w.ref ?? `"${w.title}"`);
    const total = e.fileCount ?? e.files.length;
    return e.on === "ahead"
      ? `Merge line: held to land alone: clashes with ${clashWords(names, e.files, total)}`
      : `Merge line: sent back: clashes with ${clashWords(["main"], e.files, total)}${names.length ? `, after ${names.join(", ")} landed` : ""}`;
  },
  left: (e) => `Merge line: left without merging (moved to ${e.to})`,
  takeover: (e) => `Merge line: a server took charge (${e.by}${e.commit ? `, ${e.commit.slice(0, 12)}` : ""})`,
  carried_across: (e) => `Merge line: main moved ${e.commits} commit${e.commits === 1 ? "" : "s"} since its tests passed, touching ${e.files} file${e.files === 1 ? "" : "s"}, none of this ticket's; landed without a new test`,
  rebuilt: (e) => `Merge line: main moved after its checks passed, so it is built and tested again (${e.rebuilds} time${e.rebuilds === 1 ? "" : "s"})${e.why ? `; no carry, ${e.why}${e.files?.length ? ` (${e.files.slice(0, 3).join(", ")}${e.files.length > 3 ? ", …" : ""})` : ""}` : ""}`,
  refreshed: (e) => `Merge line: main changed since this merge was built (${e.why}${e.files?.length ? `: ${e.files.slice(0, 3).join(", ")}${e.files.length > 3 ? ", …" : ""}` : ""}), so it was rebuilt before its check started, keeping its place`,
  landing_turn: (e) =>
    e.action === "taken"
      ? `Merge line: took the landing turn after ${e.rebuilds} rebuilds; other merges wait to push for up to ${e.capMin} min`
      : e.action === "queued"
      ? `Merge line: next in line for the landing turn after ${e.rebuilds} rebuilds`
      : e.action === "expired"
      ? `Merge line: the landing turn ran out after ${e.capMin} min; other merges push again`
      : "Merge line: the landing turn ended",
};

const summaryOf = (e: MergeLineEvent) => (SUMMARY[e.event] as (x: MergeLineEvent) => string)(e);

/** Events that say the line is still where it was: a retry or a repeat approval while held does not end the hold. */
const PASSIVE = ["approved", "attempt", "takeover"];

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

/**
 * BOS-1769: true when the ticket left review (a "left" row) at or after `since`, even if it is back in review now. A landing
 * started before that belongs to a pass through the line that is over: asking "is it in review now?" misses a quick
 * out-and-back, which left BOS-1706's old landing polling for hours and refusing every retry. Through the partial index.
 */
export async function leftLineSince(db: Db, ticketId: string, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ at: activity.at })
    .from(activity)
    .where(and(eq(activity.ticketId, ticketId), eq(activity.kind, MERGE_LINE_KIND), gte(activity.at, since), sql`${activity.detail}->>'event' = 'left'`))
    .limit(1);
  return !!row;
}

const sameHold = (a:Extract<MergeLineEvent, { event: "hold_started" }>, b: Extract<MergeLineEvent, { event: "hold_started" }>) =>
  a.hold === b.hold &&
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
      const ended: MergeLineEvent = { event: "hold_ended", hold: open.hold, since: last.at.toISOString(), heldMs: end.getTime() - last.at.getTime() };
      await record(db, { companyId: t.companyId, ticketId: t.id, kind: MERGE_LINE_KIND, summary: summaryOf(ended), detail: ended, at: end });
      // One millisecond later, so "the last row" is never a tie between the two.
      at = new Date(end.getTime() + 1);
    }
    await record(db, { companyId: t.companyId, ticketId: t.id, kind: MERGE_LINE_KIND, summary: summaryOf(e), detail: e as unknown as Record<string, unknown>, at });
  } catch {
    // A record of the line must never stop the line.
  }
}
