// "Being checked" (BOS-1906, BOS-1905 option 1): a ticket an agent handed in with no passing quick check waits in review with
// `check_hold_at` set, no review round open and no reviewer woken. When its check ends this settles it:
//  - passed: the mark is cleared and the reviews open (the same step as a plain move to review), with no agent run in between;
//  - failed, stuck or cancelled: the ticket goes back to In progress and its agent is woken with the failing step. The reviewers'
//    earlier records are not touched (no round was open, and a bounce from the hold never resets one).
// It runs when a check job ends and again from a sweep, so a restart between a job's end and this step loses nothing.
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { fullLogPointer } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { checkQueue, type CheckJob } from "./check-queue.js";
import { systemMoveTicket } from "./ticket-transition.js";

export type CheckHoldDeps = {
  /** Opens the review round for a ticket that was held (requests the reviews its tier needs and wakes the reviewers). */
  openReviews: (ticketId: string) => Promise<unknown>;
  /** Wakes the ticket's agent with the failing step. */
  wake: (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;
  now?: () => Date;
};

export function checkHoldService(db: Db, deps: CheckHoldDeps) {
  const queue = checkQueue(db);
  const now = () => deps.now?.() ?? new Date();

  async function release(ticketId: string, job: CheckJob): Promise<boolean> {
    // One guarded UPDATE: a ticket settled by an earlier call, or moved out of review meanwhile, is left alone.
    const [t] = await db.update(tickets).set({ checkHoldAt: null }).where(and(eq(tickets.id, ticketId), eq(tickets.systemState, "review"), isNotNull(tickets.checkHoldAt))).returning();
    if (!t) return false;
    await record(db, { companyId: t.companyId, ticketId, kind: "check_passed_review_opened", summary: `The quick check of ${job.commit.slice(0, 8)} passed, so the reviews opened.` });
    await Promise.resolve(deps.openReviews(ticketId)).catch(() => undefined);
    return true;
  }

  async function bounce(ticketId: string, job: CheckJob | null): Promise<boolean> {
    const why = !job ? "Its quick check is gone (cancelled or never ran)." : job.state === "failed" ? `The quick check of ${job.commit.slice(0, 8)} failed: ${job.reason ?? ""}` : `The quick check of ${job.commit.slice(0, 8)} did not finish (${job.state}): ${job.reason ?? "no reason recorded"}`;
    const moved = await systemMoveTicket(db, { ticketId, from: ["review"], to: "in_progress", reason: `Boss Man: ${why.slice(0, 200)}`, now: now(), stateNote: `The quick check did not pass, so it went back to In progress: ${why}`.slice(0, 480) });
    if (!moved) return false;
    if (moved.assigneeAgentId) {
      const kept = job?.state === "failed" ? await queue.logChars(job.id).catch(() => null) : null;
      const tail = (job?.logTail ? `\n\nEnd of the log:\n${job.logTail.slice(-1500)}` : "") + (kept && job ? `\n\n${fullLogPointer(job.id, ticketId, kept)}` : "");
      await Promise.resolve(
        deps.wake(moved.assigneeAgentId, {
          ticketId,
          reason: "check_result",
          priority: 2,
          note: `You handed this ticket in, and Boss Man ran its quick check. ${why}\n\nIt is back in In progress and no reviewer was woken. Fix it, commit, and move it to review again.${tail}`,
        }),
      ).catch(() => undefined);
    }
    return true;
  }

  /** Settle one held ticket from its newest quick check. Returns what happened. */
  async function settle(ticketId: string): Promise<"released" | "bounced" | "waiting" | "none"> {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!t || t.systemState !== "review" || !t.checkHoldAt) return "none";
    const jobs = await db.select().from(checkJobs).where(and(eq(checkJobs.ticketId, ticketId), eq(checkJobs.kind, "pre_review"))).orderBy(desc(checkJobs.queuedAt)).limit(10);
    if (jobs.some((j) => j.state === "queued" || j.state === "running")) return "waiting";
    const last = jobs[0] ?? null;
    if (last?.state === "passed") return (await release(ticketId, last)) ? "released" : "none";
    return (await bounce(ticketId, last)) ? "bounced" : "none";
  }

  return {
    settle,
    /** A check job ended: settle its ticket if it is held. */
    onEnded: async (job: CheckJob) => {
      if (job.kind !== "pre_review") return;
      await settle(job.ticketId);
    },
    /** Every held ticket, for the sweep that catches an end this process never saw (a restart, a crash between the job and here). */
    sweep: async (): Promise<{ released: number; bounced: number }> => {
      const held = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.systemState, "review"), isNotNull(tickets.checkHoldAt)));
      const out = { released: 0, bounced: 0 };
      for (const { id } of held) {
        const r = await settle(id).catch(() => "none" as const);
        if (r === "released") out.released++;
        if (r === "bounced") out.bounced++;
      }
      return out;
    },
  };
}
