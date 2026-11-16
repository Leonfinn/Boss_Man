// The one decision about the merge line's health (BOS-1594). Three states, from live data only:
//  - stuck: nothing is moving and somebody has to act. The only state that pages or flags the owner.
//  - over_capacity: merges are landing, but the queue is long, so the wait is long. A banner in a calm colour, no page.
//  - healthy: no banner.
// The Merge queue view carries the answer (`line`), and the Dashboard/Decisions banner and the jam notifier both read it,
// so they can never disagree. Before this, any approved ticket that had waited an hour counted as "stuck", so a line
// that landed every 15 to 30 minutes with 17 tickets behind 3 slots paged the owner.
import type { MergeQueueView } from "./merge-queue.js";
import { PHASE_LABEL, waitedText } from "./merge-queue.js";

/** Nothing landed for this long while mergeable work waits: stuck (the merge stall alarm's own limit, BOS-1515). */
export const NO_LANDING_MIN = 45;
/** A seat empty this long with work waiting: stuck (the merge stall alarm's own limit). */
export const EMPTY_SEAT_MIN = 3;
/** Over capacity when the queue would take longer than this to clear at the current rate, or something has waited this long. */
export const SLOW_AFTER_MIN = 60;
/** The landing rate is read from merges within this window. */
const RATE_WINDOW_MIN = 6 * 60;

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
  /** Minutes to clear the queue at the current landing rate; null when the rate can't be told yet (fewer than two recent landings). */
  etaMinutes: number | null;
  lastLandedAt: string | null;
  /** What adds capacity, or null when nothing would (every slot is in use, or the install can't tell). */
  advice: string | null;
};

export type MergeLineHealth = { state: "healthy" } | StuckLine | SlowLine | HeldLine;

export type HealthInput = Pick<MergeQueueView, "running" | "waiting" | "recent" | "slots">;

export type HealthOpts = {
  now: Date;
  /** When a merge-train seat went empty, as epoch ms; null when none is. Read from the train (merge-stall.ts), the seed wait excluded. */
  emptySeatSince?: number | null;
  /** Whether a check worker is connected and ready for this company; undefined when it can't be told (then no worker advice). */
  workerReady?: boolean;
  /** Approved work held behind a merge-check fix (R28); from mergeWaits, the same call that holds it. */
  heldBehindFix?: HeldBehindFix | null;
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
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

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
      reason: `${mergeable.length} ${plural(mergeable.length, "ticket is", "tickets are")} waiting while a seat sits unused`,
      fix: "The CEO sends back or moves the ticket that is in the way, so the seat fills.",
      others: mergeable.length - 1,
    };
  }
  // Nothing landed for a long time while mergeable work has waited as long. A fresh approval after a quiet night is not stuck.
  const quietMin = sinceLandingMin ?? oldestWait;
  if (mergeable.length && quietMin >= NO_LANDING_MIN && oldestWait >= NO_LANDING_MIN) {
    return {
      state: "stuck",
      cause: "no_landing",
      title: sinceLandingMin === null ? `Nothing has merged lately, and ${mergeable.length} ${plural(mergeable.length, "ticket is", "tickets are")} waiting` : `Nothing has merged for ${waitedText(sinceLandingMin)}`,
      reason: `${mergeable.length} ${plural(mergeable.length, "ticket is", "tickets are")} waiting and none has landed in that time${running.length ? "; the running check is not finishing" : "; no check is running"}`,
      fix: "The CEO looks at the line (seats, running checks, runner) and gets it moving.",
      others: mergeable.length - 1,
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
        reason: `${hb.held} approved ${plural(hb.held, "ticket is", "tickets are")} held behind it, and ${stalled.stalled!.reason}`,
        fix: `The CEO looks at ${fixName(stalled)}.`,
        others: hb.held,
      };
    }
    return { state: "held_behind_fix", held: hb.held, fixes: hb.fixes, since: hb.since };
  }

  // Not stuck. Over capacity: landing, but the queue is long.
  const inWindow = merged.filter((t) => nowMs - t <= RATE_WINDOW_MIN * 60_000);
  const gap = inWindow.length >= 2 ? (inWindow[0]! - inWindow[inWindow.length - 1]!) / (inWindow.length - 1) / 60_000 : null;
  const eta = gap === null ? null : Math.round(mergeable.length * gap);
  if (mergeable.length && ((eta !== null && eta > SLOW_AFTER_MIN) || oldestWait >= SLOW_AFTER_MIN)) {
    // Capacity is only advised when it would add something: a check worker, on an install with none connected.
    const advice = opts.workerReady === false ? "A check worker would add check slots: Settings → Server and runner → Checks → Check workers." : null;
    return { state: "over_capacity", waiting: mergeable.length, etaMinutes: eta, lastLandedAt: lastLanded === null ? null : new Date(lastLanded).toISOString(), advice };
  }
  return { state: "healthy" };
}

/** "Merging, but slowly: ..." as one plain sentence; `clock` turns the last landing into HH:MM (the server uses UTC). */
export function slowText(s: SlowLine, clock: (iso: string) => string): string {
  const eta = s.etaMinutes === null ? "" : `, about ${waitedText(s.etaMinutes)} to clear at the current rate`;
  const last = s.lastLandedAt ? `, last landed ${clock(s.lastLandedAt)}` : "";
  return `Merging, but slowly: ${s.waiting} merge ${plural(s.waiting, "check", "checks")} waiting${eta}${last}.${s.advice ? ` ${s.advice}` : ""}`;
}

/** The held line as one plain sentence; `clock` turns the start into HH:MM (the server uses UTC). Amber, never "stuck". */
export function heldText(h: HeldLine, clock: (iso: string) => string): string {
  const fixes = h.fixes.map(fixText).join(" and ");
  const owner = h.fixes.some((f) => f.ownerUpdate) ? " It goes on once you run the server update." : " They merge by themselves once it is merged and live.";
  return `Main is red: ${h.held} approved ${plural(h.held, "ticket is", "tickets are")} held behind the fix ${fixes}${h.since ? `, since ${clock(h.since)}` : ""}.${owner}`;
}
