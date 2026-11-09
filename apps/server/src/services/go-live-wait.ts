// After-merge checks wait for go-live (BOS-1021). A merged ticket's live check can't pass before the merge is
// running: not before the server runs a commit that contains it, and, for runner code, not before the runners are
// on an image built from it. The server has no git, so "contains" is read from merge order, as in
// runner-image.ts; a merge Boss Man can't place is never assumed to be live.
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { GoLiveWait } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { settings, tickets } from "../db/schema.js";
import { imageContains, runnerImageCommit } from "./runner-image.js";

const SEEN_PREFIX = "live_release:";
const isSha = (sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha);

/** The commit this company's server runs, as release-log recorded it; null before the first observation. */
export async function liveServerCommit(db: Db, companyId: string): Promise<string | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, `${SEEN_PREFIX}${companyId}`));
  const seen = (row?.value as { new?: string } | undefined) ?? {};
  return isSha(seen.new) ? seen.new.toLowerCase() : null;
}

/**
 * Every merge commit of the company, oldest merge first, whatever the ticket's state: a ticket waiting for
 * go-live is still open, so the done-only order in runner-image.ts can't place it. mergedAt is the merge time;
 * tickets merged before it existed fall back to when they were closed.
 */
export async function allMergeOrder(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ mergeCommit: tickets.mergeCommit })
    .from(tickets)
    .where(and(eq(tickets.companyId, companyId), isNotNull(tickets.mergeCommit)))
    .orderBy(asc(sql`coalesce(${tickets.mergedAt}, ${tickets.stateChangedAt})`));
  return [...new Set(rows.map((r) => r.mergeCommit!.toLowerCase()))];
}

/** True when the commit the server runs is `merge` or a merge that came after it. */
export function serverContains(live: string | null, merge: string, order: string[]): boolean {
  if (!live) return false;
  const want = merge.toLowerCase();
  if (live === want) return true;
  const at = order.indexOf(want);
  const run = order.indexOf(live);
  return at >= 0 && run >= 0 && at <= run;
}

/**
 * What a merged ticket's after-merge checks still wait for, or null when the change is live. A merge with no
 * commit (nothing in the repository) has nothing to deploy. Runner code is only waited for when the merge is
 * known to have touched it (touchesRunner true). At merge an unknown file list is stored as true (wait for both);
 * a null is only a ticket merged before this wait existed, which waits for the server alone.
 */
export async function goLiveWaitOf(db: Db, t: { companyId: string; mergeCommit: string | null; touchesRunner: boolean | null }): Promise<GoLiveWait | null> {
  if (!t.mergeCommit) return null;
  const merge = t.mergeCommit.toLowerCase();
  const [live, order] = [await liveServerCommit(db, t.companyId), await allMergeOrder(db, t.companyId)];
  // Nothing recorded about what runs (a fresh install, a runner that never said its image commit) means there
  // is nothing to wait for: that is the behaviour from before this wait existed, and it can't hang forever.
  const server = live !== null && !serverContains(live, merge, order);
  const image = await runnerImageCommit(db, t.companyId);
  const runner = t.touchesRunner === true && image !== null && !imageContains(image, merge, order);
  return server && runner ? "both" : server ? "server" : runner ? "runner" : null;
}
