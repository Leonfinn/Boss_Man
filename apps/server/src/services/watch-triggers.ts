// BOS-2288: a ticket in "Merged, watching" may name the event that wakes it (set_ticket_state watching_for +
// watch_trigger). When the event happens, the watchers of that trigger are woken once each, on their own ticket.
// BOS-2082 sat watching while 20 GitHub runs failed and nothing woke its owner; this closes that gap.
import { and, eq, isNotNull } from "drizzle-orm";
import { WATCH_TRIGGERS, type WatchTrigger } from "@boss-man/shared";
import { tickets } from "../db/schema.js";
import type { Db } from "../db/client.js";

export type WatchNotify = (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;

export const WATCH_TRIGGER_REASON = "watch trigger";

const WHAT: Record<WatchTrigger, string> = {
  gate_ci_failed: "a GitHub CI wait at the merge gate ended in a failure",
  github_main_failed: "a GitHub CI run failed on the main branch",
};

/**
 * Wakes the assignee of every blocked, merged ticket that is watching for `trigger`. `detail` says which ticket or job
 * it was. Returns how many watchers were woken. A failed wake never stops the event that caused it.
 */
export async function wakeWatchers(db: Db, notify: WatchNotify | undefined, trigger: WatchTrigger, detail: string, opts?: { exceptTicketId?: string }): Promise<number> {
  if (!notify || !WATCH_TRIGGERS.includes(trigger)) return 0;
  const rows = await db
    .select({ id: tickets.id, agentId: tickets.assigneeAgentId, title: tickets.title, watchingFor: tickets.watchingFor })
    .from(tickets)
    .where(and(eq(tickets.watchTrigger, trigger), eq(tickets.systemState, "blocked"), isNotNull(tickets.mergeCommit), isNotNull(tickets.assigneeAgentId)));
  let woken = 0;
  for (const r of rows) {
    if (!r.agentId || r.id === opts?.exceptTicketId) continue;
    const w = (await notify(r.agentId, { ticketId: r.id, reason: WATCH_TRIGGER_REASON, priority: 2, note: `Your watch fired: ${WHAT[trigger]} (${detail}). You were watching for: ${r.watchingFor ?? r.title}. Look at it now and report on this ticket, or keep watching.` }).catch(() => null)) as { status?: string } | null;
    if (w && w.status !== "dropped") woken++;
  }
  return woken;
}
