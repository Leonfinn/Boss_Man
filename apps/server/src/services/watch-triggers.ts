// BOS-2288: a ticket in "Merged, watching" may name the event that wakes it (set_ticket_state watching_for +
// watch_trigger). When the event happens, the watchers of that trigger are woken once each, on their own ticket.
// BOS-2082 sat watching while 20 GitHub runs failed and nothing woke its owner; this closes that gap.
import { and, eq, gte, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { WATCH_TRIGGERS, type WatchTrigger } from "@boss-man/shared";
import { tickets, updateHolds } from "../db/schema.js";
import type { Db } from "../db/client.js";

export type WatchNotify = (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;

export const WATCH_TRIGGER_REASON = "watch trigger";

const WHAT: Record<WatchTrigger, string> = {
  gate_ci_failed: "a GitHub CI wait at the merge gate ended in a failure",
  github_main_failed: "a GitHub CI run failed on the main branch",
  host_script_live: "the host's deployer script went live (the script it runs now matches the repo's copy)",
  server_update: "a server update ended",
  runner_update: "a runner update ended",
};

/**
 * Watches set before the update triggers existed (or by an agent that left the trigger out) name the update only in
 * their words, e.g. "the next real server update where the owner presses Ask agents to wrap up". BOS-2755: on 26 Nov such
 * a watch had no event to name and slept through the update it waited for. A watch with no trigger whose words name an
 * update of this kind is woken as well; one extra wake on a near miss costs a re-read, a missed one costs the check.
 */
const UPDATE_WORDS: Partial<Record<WatchTrigger, RegExp>> = {
  server_update: /\bserver update\b|\b(?:real|next) update\b|\bwrap[- ]?up\b/i,
  runner_update: /\brunner update\b|\b(?:real|next) update\b|\bwrap[- ]?up\b/i,
};

/**
 * Wakes the assignee of every blocked, merged ticket that is watching for `trigger`. `detail` says which ticket or job
 * it was. Returns how many watchers were woken. A failed wake never stops the event that caused it.
 */
export async function wakeWatchers(db: Db, notify: WatchNotify | undefined, trigger: WatchTrigger, detail: string, opts?: { exceptTicketId?: string }): Promise<number> {
  if (!notify || !WATCH_TRIGGERS.includes(trigger)) return 0;
  const words = UPDATE_WORDS[trigger];
  const rows = await db
    .select({ id: tickets.id, agentId: tickets.assigneeAgentId, title: tickets.title, watchingFor: tickets.watchingFor, watchTrigger: tickets.watchTrigger })
    .from(tickets)
    .where(
      and(
        words ? or(eq(tickets.watchTrigger, trigger), and(isNull(tickets.watchTrigger), isNotNull(tickets.watchingFor))) : eq(tickets.watchTrigger, trigger),
        isNotNull(tickets.assigneeAgentId),
        // BOS-2417: a check ticket that took the watch of its parent (closed at go-live) has no merge of its own.
        or(and(eq(tickets.systemState, "blocked"), isNotNull(tickets.mergeCommit)), and(ne(tickets.systemState, "done"), isNotNull(tickets.checksTicketId))),
      ),
    );
  let woken = 0;
  for (const r of rows) {
    if (!r.agentId || r.id === opts?.exceptTicketId) continue;
    if (r.watchTrigger !== trigger && !(words && r.watchingFor && words.test(r.watchingFor))) continue;
    const w = (await notify(r.agentId, { ticketId: r.id, reason: WATCH_TRIGGER_REASON, priority: 2, note: `Your watch fired: ${WHAT[trigger]} (${detail}). You were watching for: ${r.watchingFor ?? r.title}. Look at it now and report on this ticket, or keep watching.` }).catch(() => null)) as { status?: string } | null;
    if (w && w.status !== "dropped") woken++;
  }
  return woken;
}

const hhmm = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

/**
 * BOS-2755: whether the owner pressed Ask agents to wrap up for an update that ran from `from` to `to`, read from the
 * update-hold record (BOS-2408), which outlives the hold itself: a wrap-up tied to a server update can lift on the
 * pass before the server's own "ended" is read. A wrap-up hold, or a runner hold that took one over ("Wrap-up asked"),
 * that was on at any time in the window counts. Returns when it was asked, or null.
 */
export async function wrapUpDuring(db: Db, from: Date, to: Date): Promise<Date | null> {
  return (await wrapUpRecord(db, from, to)).asked;
}

/** BOS-2811: the lines the hold record keeps about a wrap-up (what it was tied to, the banner's words, how it lifted). */
export const WRAP_LINE = /^Wrap-up (tied to:|banner said:|lifted \()/;

/** When the wrap-up was asked, and the recorded lines of every wrap-up that was on in the window, oldest first. */
export async function wrapUpRecord(db: Db, from: Date, to: Date): Promise<{ asked: Date | null; lines: string[] }> {
  const rows = await db
    .select({ startedAt: updateHolds.startedAt, kind: updateHolds.kind, events: updateHolds.events })
    .from(updateHolds)
    .where(and(lte(updateHolds.startedAt, to), or(isNull(updateHolds.endedAt), gte(updateHolds.endedAt, from))))
    .orderBy(updateHolds.startedAt);
  let first: Date | null = null;
  const lines: string[] = [];
  for (const r of rows) {
    const asked = r.kind === "wrapup" ? r.startedAt : (() => { const e = r.events.find((x) => x.text === "Wrap-up asked"); return e ? new Date(e.at) : null; })();
    if (asked && (!first || asked < first)) first = asked;
    if (asked) for (const e of r.events) if (WRAP_LINE.test(e.text)) lines.push(`${hhmm(new Date(e.at))}: ${e.text}`);
  }
  return { asked: first, lines };
}

/** The wake's detail for an update that ended: which one (commit, times), how it ended, and whether a wrap-up was pressed. */
export function updateDetail(u: { what: "server" | "runner"; commit: string; result: string; started: Date | null; ended: Date; wrapUpAt: Date | null; wrapLines?: string[] }): string {
  const ran = u.started ? `from ${hhmm(u.started)} to ${hhmm(u.ended)}` : `at ${hhmm(u.ended)}`;
  const wrap = u.wrapUpAt ? `a wrap-up was pressed for it (asked ${hhmm(u.wrapUpAt)})` : "no wrap-up was pressed for it";
  // BOS-2811: what the hold record kept of the wrap-up (its tie, the banner's exact words, how it lifted), to quote.
  const lines = u.wrapUpAt && u.wrapLines?.length ? ` Recorded wrap-up lines: ${u.wrapLines.map((l) => `[${l}]`).join(" ")}` : "";
  return `${u.what} update to ${u.commit.slice(0, 8) || "an unknown commit"} ended "${u.result}" ${ran} on ${u.ended.toISOString().slice(0, 10)}; ${wrap}${lines}`;
}

/** Wakes the watchers of a server or runner update that ended. Never throws. */
export async function wakeUpdateWatchers(db: Db, notify: WatchNotify | undefined, u: { what: "server" | "runner"; commit: string; result: string; started: Date | null; ended: Date; wrapUpAt?: Date | null }, log?: (m: string) => void): Promise<number> {
  try {
    if (!notify) return 0;
    // The window starts a little before the update so a wrap-up pressed just before it was sent still counts.
    const from = new Date((u.started ?? u.ended).getTime() - 10 * 60_000);
    const rec = await wrapUpRecord(db, from, u.ended);
    const wrapUpAt = u.wrapUpAt ?? rec.asked;
    return await wakeWatchers(db, notify, u.what === "server" ? "server_update" : "runner_update", updateDetail({ ...u, wrapUpAt, wrapLines: rec.lines }));
  } catch (err) {
    log?.(`waking the ${u.what}-update watchers failed: ${(err as Error).message}`);
    return 0;
  }
}
