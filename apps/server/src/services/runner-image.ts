// Whether the live runner image already has a change (BOS-764). The image is built from the commit the host
// had checked out, and the runner tells the server that commit in its hello (BOS-764: BOSSMAN_IMAGE_COMMIT). A
// "Build and update runners" ask is only worth the owner's click when the image does NOT contain the change, so
// the cards that ask for it check here first, and an open one closes once a rebuild from a commit that has the
// change goes live. The server has no git, so "contains" is read from merge order, the same way DR-011 places a
// ticket: the merge gate merges one ticket at a time, so a commit that merged at or before the image's commit is
// inside it. A commit Boss Man can't place is never assumed to be inside the image.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runners, tickets } from "../db/schema.js";
import { allMergeOrder, commitIsLive, serverContains } from "./go-live-wait.js";

const isSha = (sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha);

/** The commit the company's live runner image was built from, or null when it hasn't been recorded. */
export async function runnerImageCommit(db: Db, companyId: string): Promise<string | null> {
  const [row] = await db.select({ commit: runners.imageCommit }).from(runners).where(eq(runners.companyId, companyId));
  return isSha(row?.commit) ? row.commit.toLowerCase() : null;
}

/**
 * True only when the image was built from `commit` or from a merge that came after it. False when the image's
 * commit isn't recorded or either commit can't be placed in merge order: then the owner is asked, as before.
 */
export function imageContains(image: string | null, commit: string | null | undefined, order: string[], contains: readonly string[] = []): boolean {
  if (!image || !commit) return false;
  // `contains`: commits the image's commit is known to contain (BOS-1640), when it is the server's live commit.
  return serverContains(image, commit, order, contains);
}

/**
 * A ticket's setup steps: one per line, blank lines left off. A fenced command block (an opening ``` line, the
 * command, a closing ``` line) stays together as ONE step, so a host command can say where it runs with
 * ```sh host="<name>" as="root" (BOS-1953). A fence that is never closed is read line by line, as before.
 */
export function splitSteps(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (/^```[^`]*$/.test(line)) {
      const close = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l.trim()));
      if (close > 0) {
        out.push([line, ...lines.slice(i + 1, close).map((l) => l.trimEnd()), "```"].join("\n"));
        i = close;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

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
  const order = await allMergeOrder(db, companyId);
  const live = liveCommit.toLowerCase();
  const lacking: typeof only = [];
  for (const t of only) {
    // The live side is the commit being asked about (a deploy not yet recorded); the runner side is the one answer.
    if (serverContains(live, t.mergeCommit!, order) && !(await commitIsLive(db, companyId, t.mergeCommit, "runner"))) lacking.push(t);
  }
  return lacking
    .sort((a, b) => order.indexOf(a.mergeCommit!.toLowerCase()) - order.indexOf(b.mergeCommit!.toLowerCase()))
    .map((t) => ({ ticketId: t.id, title: t.title, mergeCommit: t.mergeCommit!.toLowerCase() }));
}
