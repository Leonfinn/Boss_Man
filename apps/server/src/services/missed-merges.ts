// BOS-1645 (R27): merges on main that the gate never recorded. On 16 Nov a runner swap cut the gate off just after
// BOS-1635's push: main had the merge, the ticket said "not merged", and the live commit could not be placed, which
// gave wrong "not live" answers and a refused runner update. review.ts's recordMissedMerges compares main's newest
// first-parent commits (the runner's workspace.mainLog) with the recorded merges and records the missing ones; this
// file holds the parts that need no runner: reading a merge subject, and the CEO's one wake for a live commit that
// still can't be placed afterwards.
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, settings } from "../db/schema.js";
import { allMergeOrder, liveServerRecord, placeInOrder } from "./go-live-wait.js";

/** How many of main's newest first-parent commits each sweep reads: hours of merges, far more than one swap can lose. */
export const MAIN_LOG_MAX = 50;

/**
 * The gate's merge message for a ticket. The title is agent-written and may hold line breaks; they become spaces, so the
 * message is one line and its first paragraph (git's %s) can never end in another ticket's id (Jane, BOS-1645).
 */
export function gateMergeMessage(title: string, ticketId: string): string {
  return `Merge "${title.replace(/[ \t]*[\r\n]+[ \t]*/g, " ")}" (${ticketId})`;
}

/**
 * The ticket id a gate merge message names (the id the gate appends last). Null for anything else (a hand merge, a squash,
 * a direct push), which this sweep never guesses a ticket for. Only a candidate: isGateMergeOf decides.
 */
export function mergeMessageTicket(message: string): string | null {
  const m = /^Merge "[\s\S]*" \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/i.exec(message.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Whether a commit's full message is exactly the gate's merge message for this ticket, built from its own row: only then
 * does the sweep record the commit as its merge. Also the pre-BOS-1645 form, whose title kept its line breaks.
 */
export function isGateMergeOf(message: string, t: { id: string; title: string }): boolean {
  const m = message.trim();
  return m === gateMergeMessage(t.title, t.id) || m === `Merge "${t.title}" (${t.id})`.trim();
}

const KEY = (companyId: string) => `live_unplaced:${companyId}`;
export const LIVE_UNPLACED_REASON = "live commit not placed";

/**
 * After a sweep that read main: when the commit the server runs still can't be placed in merge order (it is no recorded
 * merge and contains none it is known to), wake the CEO once for that commit, with it and why. The same commit never
 * wakes again; a new one does, and a placeable one clears the record. `onMain`: main's newest commits as the sweep read
 * them, so the note can say whether the commit is on main at all. Returns true when the CEO was woken.
 */
export async function wakeCeoIfLiveUnplaced(
  db: Db,
  companyId: string,
  onMain: Array<{ sha: string; subject: string; message: string }>,
  wake: ((agentId: string, input: { reason: string; note: string }) => Promise<unknown>) | null | undefined,
): Promise<boolean> {
  const { live, contains } = await liveServerRecord(db, companyId);
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY(companyId)));
  const seen = (row?.value as { commit?: string } | undefined)?.commit ?? null;
  if (!live || placeInOrder(live, await allMergeOrder(db, companyId), contains) >= 0) {
    if (row) await db.delete(settings).where(eq(settings.key, KEY(companyId)));
    return false;
  }
  if (!wake || seen === live) return false;
  const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
  if (!ceo) return false;
  const hit = onMain.find((c) => c.sha.toLowerCase() === live);
  const why = !hit
    ? `it isn't among main's newest ${onMain.length} first-parent commits, so it may be an older commit, a commit from another branch, or a build by hand`
    : mergeMessageTicket(hit.message)
      ? `it is on main as "${hit.subject.slice(0, 160)}", but that ticket isn't one of this company's tickets, or its record failed`
      : `it is on main as "${hit.subject.slice(0, 160)}", which is not a merge by the gate (no ticket id in it), so no ticket owns it`;
  const w = await wake(ceo.id, {
    reason: LIVE_UNPLACED_REASON,
    note: `The server runs ${live.slice(0, 12)}, which Boss Man can't place among its recorded merges even after checking main for merges it missed: ${why}. Until it is placed, "is it live?" answers and the runner update line can't tell. Find which ticket that commit belongs to and record or explain it; log it in the cock-ups log if it is a new kind. Boss Man wakes you once per commit.`,
  });
  if (w && typeof w === "object" && (w as { status?: string }).status === "dropped") return false;
  const value = { commit: live, at: new Date().toISOString() };
  await db.insert(settings).values({ key: KEY(companyId), value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  return true;
}
