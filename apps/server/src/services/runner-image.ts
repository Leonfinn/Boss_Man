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

/**
 * This company's merge commits, oldest merge first (the merge gate merges one at a time, so this is merge order).
 * Ordered by stateChangedAt, which is set when the ticket moves to done and not by later notes or touches;
 * lastActivityAt keeps moving on a done ticket and would reorder merges. Release-log shares this helper.
 */
export async function mergeCommitOrder(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ mergeCommit: tickets.mergeCommit })
    .from(tickets)
    .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done")))
    .orderBy(asc(tickets.stateChangedAt));
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

/** A ticket's setup steps as lines: one per step, blank lines and a leading "1." left off. */
export const splitSteps = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Spaces, tabs and newlines alike, so the same step written differently reads the same (BOS-741). */
export const stepKey = (step: string) => step.replace(/\s+/g, " ").trim();

/**
 * A step that only asks for the runner update (BOS-741): Boss Man's own runner-update card covers it, so it
 * doesn't get a card of its own. Exact after normalising whitespace, never a guess: a step that asks for the
 * runner update and something else is not just about the runners and keeps its card.
 */
const RUNNER_ONLY_STEPS = new Set(["Build and update runners", "Rebuild the runners: Settings → Server and runner → Updates → Build and update runners"]);
export const isRunnerOnlyStep = (step: string) => RUNNER_ONLY_STEPS.has(stepKey(step));

export type RunnerOnlyTicket = { ticketId: string; title: string; mergeCommit: string };

/**
 * The live tickets whose only remaining setup step is the runner update and whose merge the runners lack
 * (DR-042 point 5), oldest merge first. "Live" means the merge is at or before `liveCommit` in merge order (or is
 * it); a merge Boss Man can't place is left out rather than guessed at. One check serves the runner card, the
 * button and the offer: `imageContains` decides what the runners already have.
 */
export async function runnerOnlyTickets(db: Db, companyId: string, liveCommit: string): Promise<RunnerOnlyTicket[]> {
  const rows = await db
    .select({ id: tickets.id, title: tickets.title, ownerSetup: tickets.ownerSetup, mergeCommit: tickets.mergeCommit })
    .from(tickets)
    .where(and(eq(tickets.companyId, companyId), eq(tickets.systemState, "done")));
  const only = rows.filter((t) => {
    if (!t.mergeCommit || !t.ownerSetup?.trim()) return false;
    const steps = splitSteps(t.ownerSetup);
    return steps.length > 0 && steps.every(isRunnerOnlyStep);
  });
  if (!only.length) return [];
  const [image, order] = [await runnerImageCommit(db, companyId), await mergeCommitOrder(db, companyId)];
  const live = liveCommit.toLowerCase();
  const liveAt = order.indexOf(live);
  return only
    .filter((t) => {
      const merge = t.mergeCommit!.toLowerCase();
      const at = order.indexOf(merge);
      const isLive = merge === live || (at >= 0 && liveAt >= 0 && at <= liveAt);
      return isLive && !imageContains(image, merge, order);
    })
    .sort((a, b) => order.indexOf(a.mergeCommit!.toLowerCase()) - order.indexOf(b.mergeCommit!.toLowerCase()))
    .map((t) => ({ ticketId: t.id, title: t.title, mergeCommit: t.mergeCommit!.toLowerCase() }));
}
