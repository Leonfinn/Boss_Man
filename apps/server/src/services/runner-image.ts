// Whether the live runner image already has a change (BOS-764). The image is built from the commit the host
// had checked out, and the runner tells the server that commit in its hello (BOS-764: BOSSMAN_IMAGE_COMMIT). A
// "Build and update runners" ask is only worth the owner's click when the image does NOT contain the change, so
// the cards that ask for it check here first, and an open one closes once a rebuild from a commit that has the
// change goes live. The server has no git, so "contains" is read from merge order, the same way DR-011 places a
// ticket: the merge gate merges one ticket at a time, so a commit that merged at or before the image's commit is
// inside it. A commit Boss Man can't place is never assumed to be inside the image.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runners, tickets } from "../db/schema.js";

const isSha = (sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha);

/** The commit the company's live runner image was built from, or null when it hasn't been recorded. */
export async function runnerImageCommit(db: Db, companyId: string): Promise<string | null> {
  const [row] = await db.select({ commit: runners.imageCommit }).from(runners).where(eq(runners.companyId, companyId));
  return isSha(row?.commit) ? row.commit.toLowerCase() : null;
}

/** This company's merge commits, oldest merge first (the merge gate merges one at a time, so this is merge order). */
export async function mergeCommitOrder(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ mergeCommit: tickets.mergeCommit })
    .from(tickets)
    .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done")))
    .orderBy(asc(tickets.lastActivityAt));
  return [...new Set(rows.map((r) => r.mergeCommit?.toLowerCase()).filter((c): c is string => !!c))];
}

/**
 * True only when the image was built from `commit` or from a merge that came after it. False when the image's
 * commit isn't recorded or either commit can't be placed in merge order: then the owner is asked, as before.
 */
export function imageContains(image: string | null, commit: string | null | undefined, order: string[]): boolean {
  if (!image || !commit) return false;
  const want = commit.toLowerCase();
  if (image === want) return true;
  const at = order.indexOf(want);
  const built = order.indexOf(image);
  return at >= 0 && built >= 0 && at <= built;
}
