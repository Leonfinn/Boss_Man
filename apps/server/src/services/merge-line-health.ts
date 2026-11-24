// The one decision about the merge line's health (BOS-1594). Three states, from live data only:
//  - stuck: nothing is moving and somebody has to act. The only state that pages or flags the owner.
//  - over_capacity: merges are landing, but the queue is long, so the wait is long. A banner in a calm colour, no page.
//  - healthy: no banner.
// The Merge queue view carries the answer (`line`), and the Dashboard/Decisions banner and the jam notifier both read it,
// so they can never disagree. Before this, any approved ticket that had waited an hour counted as "stuck", so a line
// that landed every 15 to 30 minutes with 17 tickets behind 3 slots paged the owner.
import { figureText, slowLineCounts } from "@boss-man/shared";
import type { MergeQueueView } from "./merge-queue.js";
import { PHASE_LABEL, waitedText } from "./merge-queue.js";

/** Nothing landed for this long while mergeable work waits: stuck (the merge stall alarm's own limit, BOS-1515). */
export const NO_LANDING_MIN = 45;
/** A seat empty this long with work waiting: stuck (the merge stall alarm's own limit). */
export const EMPTY_SEAT_MIN = 3;
/** Over capacity when the queue would take longer than this to clear at the current rate, or something has waited this long. */
export const SLOW_AFTER_MIN = 60;

export type StuckCause = "check_too_long" | "gate_fault" | "empty_seat" | "no_landing" | "fix_stalled";

/** A ticket marked as fixing the merge check that holds approved work (R28): who, what state, and whether it is stuck. */
export type HeldFix = {
  ticketId: string;
  ref: string | null;
  title: string;
  /** The fix's state in plain words: "in review", "merged, waiting for the server update". */
  stateText: string;
  /** The fix is merged and only the owner's server update (or runner rebuild) is left. */
  ownerUpdate: boolean;
  /** With ownerUpdate: the owner's open update card, to link; null when none is open (no new card is raised for this line). */
  updateCardId?: string | null;
  /** The fix was sent back / parked, or has been landing for over an hour with no result (set by the caller). */
  stalled: { reason: string } | null;
};

/** What mergeWaits holds, read by the Merge queue from the same call that holds (mergeHolds): approved work held behind fixes. */
export type HeldBehindFix = { held: number; fixes: HeldFix[]; since: string | null };

export type HeldLine = {
  state: "held_behind_fix";
  held: number;
  fixes: HeldFix[];
  /** When the earliest hold began (main went red), or null when unknown. */
  since: string | null;
};

export type StuckLine = {
  state: "stuck";
  cause: StuckCause;
  /** One line: what is stuck. */
  title: string;
  /** Why, in plain words. */
  reason: string;
  /** The one step that fixes it, and who takes it. */
  fix: string;
  /** How many other pieces of work are stuck or waiting behind it. */
  others: number;
};

export type SlowLine = {
  state: "over_capacity";
  waiting: number;
  /** Everything in the merge line, waiting or running (the sidebar badge, `lineCount`); only present when more than `waiting` (the rest are merging now, or wait on an agent or the owner). */
  inQueue?: number;
  /** Minutes to clear the queue at the current landing rate; null when the rate can't be told yet (too few recent landings over too short a time). */
  etaMinutes: number | null;
  /** BOS-2505: the same estimate as a time (ISO): when the last one is expected to land. Null with etaMinutes. */
  etaAt?: string | null;
  lastLandedAt: string | null;
  /** What adds capacity, or null when nothing would (every slot is in use, or the install can't tell). */
  advice: string | null;
};

/** R44: new checks are paused on purpose (a server update waits for a quiet machine). No estimate, no alarm while it lasts. */
export type PausedLine = {
  state: "paused";
  /** What the pause is for, as a noun phrase: "a server update". */
  reason: string;
  since: string;
  /** The latest the pause can last (the soft hold's cap). */
  until: string;
  /** Check slots in use and in total, for the slot line "2 of 5 in use: new checks paused". */
  inUse: number;
  slots: number;
};

export type MergeLineHealth = { state: "healthy" } | StuckLine | SlowLine | HeldLine | PausedLine;

/** A deliberate pause on new checks: from the soft hold (softHoldReason); null when none. */
export type LinePause = { reason: string; since: string; until: string };

export type HealthInput = Pick<MergeQueueView, "running" | "waiting" | "recent" | "slots">;

export type HealthOpts = {
  now: Date;
  /** When a merge-train seat went empty, as epoch ms; null when none is. Read from the train (merge-stall.ts), the seed wait excluded. */
  emptySeatSince?: number | null;
  /** Whether a check worker is connected and ready for this company; undefined when it can't be told (then no worker advice). */
  workerReady?: boolean;
  /** Approved work held behind a merge-check fix (R28); from mergeWaits, the same call that holds it. */
  heldBehindFix?: HeldBehindFix | null;
  /** R44: a deliberate pause on new checks. While it lasts the verdict is "paused": no stuck, slow or jam verdict. */
  pause?: LinePause | null;
  /** BOS-2505: when the last ticket of the line is expected to land (epoch ms, from lineClearAt); null/absent when it can't be told yet. */
  clearAt?: number | null;
};

const fixName = (f: HeldFix) => f.ref ?? `"${f.title}"`;
/** "BOS-1641 (merged, waiting for the server update)": the fix and its state. */
export function fixText(f: HeldFix): string {
  return `${fixName(f)} (${f.stateText})`;
}

/** The waiting states that are the line's own capacity at work, not a fault: a slot or a seat to come. */
const CAPACITY_STATES = new Set(["waiting_for_check_capacity", "waiting_for_seat"]);
/** Rows Boss Man itself moves: neither a card, an agent nor the owner is the next step. */
const SYSTEM_WAIT_STATES = new Set(["waiting_for_check_capacity", "waiting_for_seat", "waiting_for_slot", "waiting_host", "waiting_for_other_ticket", "checking"]);

const upFirst = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const refOf = (r: { ref: string | null; title: string }) => r.ref ?? `"${r.title}"`;

/** Pure. The state of the merge line, from the Merge queue read and (optionally) the train and worker facts. */
export function mergeLineHealth(view: HealthInput, opts: HealthOpts): MergeLineHealth {
  const nowMs = opts.now.getTime();
  const running = (view.running ?? []).filter((r) => r.what === "merge_check");
  const waiting = view.waiting ?? [];
  // Work Boss Man itself has to move. A card, an agent or the owner holds the rest, and has its own notice.
  const mergeable = waiting.filter((w) => w.actor === "system" && !w.decisionId && SYSTEM_WAIT_STATES.has(w.state));
  const oldestWait = mergeable.reduce((m, w) => Math.max(m, w.minutes), 0);

  const merged = (view.recent ?? []).filter((r) => r.result === "merged").map((r) => new Date(r.at).getTime()).filter(Number.isFinite).sort((a, b) => b - a);
  const lastLanded = merged[0] ?? null;
  const sinceLandingMin = lastLanded === null ? null : Math.max(0, Math.round((nowMs - lastLanded) / 60_000));

  // R44: a deliberate pause is a verdict of its own. Nothing waits too long or stalls while checks are held on purpose.
  if (opts.pause) return { state: "paused", ...opts.pause, inUse: running.length, slots: view.slots };

  const overLimit = running.filter((r) => r.overLimit);
  // A stuck waiting row that is not simply waiting its turn for a slot or seat: no runner, a host fault, a carried-work wait.
  const faults = mergeable.filter((w) => w.stuck && !CAPACITY_STATES.has(w.state));

  if (overLimit.length) {
    const r = overLimit[0]!;
    return {
      state: "stuck",
      cause: "check_too_long",
      title: `${refOf(r)} has been ${r.phase === "merging" ? "merging" : "in its check"} for ${waitedText(r.minutes)}`,
      reason: `${refOf(r)} is past the one-hour limit for a merge check, and Boss Man is still ${PHASE_LABEL[r.phase as keyof typeof PHASE_LABEL] ?? "working on it"}`,
      fix: "The CEO opens the ticket's check log and, if the check has hung, stops it so the line moves on.",
      others: overLimit.length + mergeable.length - 1,
    };
  }
  if (faults.length) {
    const w = faults[0]!;
    return {
      state: "stuck",
      cause: "gate_fault",
      title: `${refOf(w)} has waited ${waitedText(w.minutes)} to merge`,
      reason: upFirst(w.label),
      fix: w.next ?? "Boss Man keeps working on it by itself.",
      others: mergeable.length - 1,
    };
  }
  if (opts.emptySeatSince != null && mergeable.length && nowMs - opts.emptySeatSince >= EMPTY_SEAT_MIN * 60_000) {
    return {
      state: "stuck",
      cause: "empty_seat",
      title: `A merge-train seat has been empty for ${waitedText(Math.round((nowMs - opts.emptySeatSince) / 60_000))}`,
      reason: `${figureText("mergeQueue.forBossMan", mergeable.length)} while a seat sits unused`,
      fix: "The CEO sends back or moves the ticket that is in the way, so the seat fills.",
      others: mergeable.length - 1,
    };
  }
  // Nothing landed for a long time while mergeable work has waited as long. A fresh approval after a quiet night is not stuck.
  // BOS-2361: merges waiting for another ticket's landing turn count here too: a turn held long with nothing landing is
  // this stall (they were left out, so a line where every merge waited on the holder read healthy).
  const turnWaiting = waiting.filter((w) => w.actor === "system" && !w.decisionId && w.state === "waiting_for_turn");
  const stalled = mergeable.length + turnWaiting.length;
  const stalledOldest = Math.max(oldestWait, ...turnWaiting.map((w) => w.minutes));
  const quietMin = sinceLandingMin ?? stalledOldest;
  if (stalled && quietMin >= NO_LANDING_MIN && stalledOldest >= NO_LANDING_MIN) {
    return {
      state: "stuck",
      cause: "no_landing",
      title: sinceLandingMin === null ? `Nothing has merged lately, with ${figureText("mergeQueue.forBossMan", stalled)}` : `Nothing has merged for ${waitedText(sinceLandingMin)}`,
      reason: `${figureText("mergeQueue.forBossMan", stalled)}, and none has landed in that time${running.length ? "; the running check is not finishing" : "; no check is running"}${turnWaiting.length ? `; ${turnWaiting.length} wait${turnWaiting.length === 1 ? "s" : ""} for another ticket's landing turn` : ""}`,
      fix: "The CEO looks at the line (seats, running checks, runner, the landing turn's holder) and gets it moving.",
      others: stalled - 1,
    };
  }

  // R28: approved work is held behind a merge-check fix. A fix that stalled is the line's fault; otherwise it is calm, expected waiting.
  const hb = opts.heldBehindFix;
  if (hb && hb.held > 0 && hb.fixes.length) {
    const stalled = hb.fixes.find((f) => f.stalled);
    if (stalled) {
      return {
        state: "stuck",
        cause: "fix_stalled",
        title: `The fix for main, ${fixName(stalled)}, has stalled`,
        reason: `${figureText("mergeQueue.heldBehindFix", hb.held)} it, and ${stalled.stalled!.reason}`,
        fix: `The CEO looks at ${fixName(stalled)}.`,
        others: hb.held,
      };
    }
    return { state: "held_behind_fix", held: hb.held, fixes: hb.fixes, since: hb.since };
  }

  // Not stuck. Over capacity: landing, but the queue is long.
  // BOS-2505: when the last one lands comes from the line's own times (lineClearAt: checks left, GitHub waits, the train),
  // not a landing rate, which a burst of landings made far too fast. Null when the usual times are not known yet.
  const clearAt = opts.clearAt ?? null;
  const eta = clearAt === null ? null : Math.max(0, Math.round((clearAt - nowMs) / 60_000));
  if (mergeable.length && ((eta !== null && eta > SLOW_AFTER_MIN) || oldestWait >= SLOW_AFTER_MIN)) {
    // Capacity is only advised when it would add something: a check worker, on an install with none connected.
    const advice = opts.workerReady === false ? "A check worker would add check slots: Settings → Server and runner → Limits and checks → Check workers." : null;
    // inQueue: the sidebar badge's figure, mergeQueue.inLine (R43: everything on the Merges tab, waiting or running);
    // `waiting` is mergeQueue.forBossMan, only those Boss Man itself has to move.
    const inLine = waiting.length + (view.running ?? []).length;
    return { state: "over_capacity", waiting: mergeable.length, ...(inLine !== mergeable.length ? { inQueue: inLine } : {}), etaMinutes: eta, etaAt: clearAt === null ? null : new Date(clearAt).toISOString(), lastLandedAt: lastLanded === null ? null : new Date(lastLanded).toISOString(), advice };
  }
  return { state: "healthy" };
}

/** The line must have grown for this long before the start-brake warning shows (R47). */
export const BRAKE_GROWN_MIN = 60;
/** The suggested limit is this many hours of the landing rate: a line the team clears in about that time. */
export const BRAKE_SUGGEST_HOURS = 2.5;
/** The landing rate is read over this many hours (a day, so one quiet night doesn't read as a zero rate beyond the floor below). */
const BRAKE_RATE_HOURS = 24;
/** Never suggest a limit below this: a limit of 1 or 2 would hold starts for no reason. */
const BRAKE_MIN_SUGGEST = 3;

export type StartBrakeOff = { waiting: number; suggestedLimit: number };

/**
 * R47: the start brake (BOS-1489) has no limit and the merge line has grown for an hour: say so, with a limit to set. Pure.
 * "Grown" = more tickets joined the line in the last hour than landed in it (the line's rows carry how long each has waited).
 * Null when a limit is set, the line has not grown, or the line is no longer than the suggested limit.
 * `landed` is the landing times (epoch ms) of the last day.
 */
export function startBrakeOff(i: { brakeLimit: number | null; waiting: Array<{ minutes: number }>; landed: number[]; now: Date }): StartBrakeOff | null {
  if (i.brakeLimit != null) return null;
  const nowMs = i.now.getTime();
  const joined = i.waiting.filter((w) => w.minutes < BRAKE_GROWN_MIN).length;
  const landed = i.landed.filter((t) => nowMs - t <= BRAKE_GROWN_MIN * 60_000).length;
  if (joined <= landed) return null;
  const perDay = i.landed.filter((t) => nowMs - t <= BRAKE_RATE_HOURS * 3_600_000).length;
  const suggestedLimit = Math.max(BRAKE_MIN_SUGGEST, Math.round((perDay / BRAKE_RATE_HOURS) * BRAKE_SUGGEST_HOURS));
  if (i.waiting.length <= suggestedLimit) return null;
  return { waiting: i.waiting.length, suggestedLimit };
}

export function startBrakeText(b: StartBrakeOff): string {
  return `Start brake off, ${b.waiting} waiting; suggested limit ${b.suggestedLimit}`;
}

/** "Merging, but slowly: ..." as one plain sentence; `clock` turns the last landing into HH:MM (the server uses UTC). */
export function slowText(s: SlowLine, clock: (iso: string) => string): string {
  const eta = s.etaAt ? `, the last one expected by about ${clock(s.etaAt)}` : ", no estimate yet";
  const last = s.lastLandedAt ? `, last landed ${clock(s.lastLandedAt)}` : "";
  // R43: the counts in the shared words the web's banner also uses.
  return `Merging, but slowly: ${slowLineCounts(s)}${eta}${last}.${s.advice ? ` ${s.advice}` : ""}`;
}

/** The held line as one plain sentence; `clock` turns the start into HH:MM (the server uses UTC). Amber, never "stuck". */
export function heldText(h: HeldLine, clock: (iso: string) => string): string {
  const fixes = h.fixes.map(fixText).join(" and ");
  const owner = h.fixes.some((f) => f.ownerUpdate) ? " It goes on once you run the server update." : " They merge by themselves once it is merged and live.";
  return `Merges are held: ${figureText("mergeQueue.heldBehindFix", h.held)} the fix ${fixes}${h.since ? `, since ${clock(h.since)}` : ""}.${owner}`;
}

/** The paused line as one plain sentence; `clock` turns a time into HH:MM (the server uses UTC). */
export function pausedText(p: PausedLine, clock: (iso: string) => string): string {
  return `Paused for ${p.reason} since ${clock(p.since)}; new checks start once it is done, by ${clock(p.until)} at the latest. ${p.inUse} of ${p.slots} ${p.slots === 1 ? "slot" : "slots"} in use: new checks paused.`;
}
