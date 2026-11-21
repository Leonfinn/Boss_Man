// "Being checked" (BOS-1906, BOS-1905 option 1): a ticket an agent handed in with no passing quick check waits in review with
// `check_hold_at` set, no review round open and no reviewer woken. When its check ends this settles it:
//  - passed: the mark is cleared and the reviews open (the same step as a plain move to review), with no agent run in between;
//  - failed, stuck or cancelled: the ticket goes back to In progress and its agent is woken with the failing step. The reviewers'
//    earlier records are not touched (no round was open, and a bounce from the hold never resets one).
// It runs when a check job ends and again from a sweep, so a restart between a job's end and this step loses nothing.
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { fullLogPointer, missingVerdicts, readCriteria } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs, runs, tickets, workflowColumns } from "../db/schema.js";
import { record } from "./activity.js";
import { checkQueue, type CheckJob } from "./check-queue.js";
import { moveTicket } from "./ticket-moves.js";
import { systemMoveTicket } from "./ticket-transition.js";

export type CheckHoldDeps = {
  /** Opens the review round for a ticket that was held (requests the reviews its tier needs and wakes the reviewers). */
  openReviews: (ticketId: string) => Promise<unknown>;
  /** Wakes the ticket's agent with the failing step. */
  wake: (agentId: string, input: { ticketId: string; reason: string; note: string; priority?: number }) => Promise<unknown>;
  now?: () => Date;
  /** The head commit of a ticket's branch (null when it can't be read). Without it the standing sweep (BOS-2114) does nothing and a pass is released as before. */
  branchHead?: (ticketId: string) => Promise<string | null>;
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
    if (last?.state === "passed") {
      // BOS-1906 note: a pass for a commit other than the branch head covers code that has since changed; it opens no reviews.
      const head = deps.branchHead ? await deps.branchHead(ticketId).catch(() => null) : null;
      if (head && head !== last.commit) return (await bounceStale(ticketId, last, head)) ? "bounced" : "none";
      return (await release(ticketId, last)) ? "released" : "none";
    }
    return (await bounce(ticketId, last)) ? "bounced" : "none";
  }

  /** Back to In progress, no wake: the agent's own run is what changed the branch (or nobody is working on it and the next wake finds the note). */
  async function bounceStale(ticketId: string, job: CheckJob, head: string): Promise<boolean> {
    const why = `The quick check of ${job.commit.slice(0, 8)} passed, but the branch is now at ${head.slice(0, 8)}, which no check covers. Move it to review again to check the new code.`;
    return !!(await systemMoveTicket(db, { ticketId, from: ["review"], to: "in_progress", reason: `Boss Man: ${why.slice(0, 200)}`, now: now(), stateNote: why.slice(0, 480) }));
  }

  /** Tickets whose agent has a live run on them (BOS-2114). */
  async function withOwnRun(rows: Array<{ id: string; assigneeAgentId: string | null }>): Promise<Set<string>> {
    if (!rows.length) return new Set();
    const live = await db.select({ ticketId: runs.ticketId, agentId: runs.agentId }).from(runs).where(and(inArray(runs.ticketId, rows.map((r) => r.id)), isNull(runs.endedAt)));
    return new Set(live.filter((r) => rows.some((t) => t.id === r.ticketId && t.assigneeAgentId === r.agentId)).map((r) => r.ticketId as string));
  }

  /**
   * BOS-2114: a standing version of the one-off migration. An In progress ticket whose quick check of the branch head is queued or running,
   * with no run of its own, only waits for that check: it moves into "Being checked" as a hand-in would. A held ticket whose agent has
   * started a run again and moved the branch past the checked commit goes back to In progress.
   */
  async function sweepProgress(): Promise<{ held: number; returned: number }> {
    const out = { held: 0, returned: 0 };
    if (!deps.branchHead) return out;
    const live = await db.selectDistinct({ ticketId: checkJobs.ticketId }).from(checkJobs).where(and(eq(checkJobs.kind, "pre_review"), inArray(checkJobs.state, ["queued", "running"])));
    if (!live.length) return out;
    const rows = await db.select().from(tickets).where(and(inArray(tickets.id, live.map((l) => l.ticketId)), inArray(tickets.systemState, ["in_progress", "review"]), isNull(tickets.mergedAt), eq(tickets.noCode, false)));
    const own = await withOwnRun(rows);
    for (const t of rows) {
      const head = await deps.branchHead(t.id).catch(() => null);
      if (!head) continue;
      const [job] = await db.select().from(checkJobs).where(and(eq(checkJobs.ticketId, t.id), eq(checkJobs.kind, "pre_review"), eq(checkJobs.commit, head), inArray(checkJobs.state, ["queued", "running"]))).limit(1);
      // A request_check made mid-work queues the same job as one on finished work. Only a ticket whose agent has reported every
      // before-merge criterion is taken to be finished; any other stays In progress, so the reviews never open on unfinished code.
      const finished = missingVerdicts(readCriteria(t.acceptanceCriteria), t.stateNote, "before").length === 0;
      if (t.systemState === "in_progress" && job && !own.has(t.id) && finished) {
        // Through moveTicket (BOS-922): no hooks, so no review round opens and no reviewer is woken until the check passes.
        const at = now();
        const moved = await moveTicket(db, t.id, "review", { from: ["in_progress"], expectedVersion: t.version, internal: true, overLimit: true, reviewRound: "keep", note: "Boss Man: only its quick check was left", fields: { checkHoldAt: at }, now: at }).then((r) => r.changed, () => false);
        if (moved) {
          await record(db, { companyId: t.companyId, ticketId: t.id, kind: "check_hold_swept", summary: `Only its quick check of ${head.slice(0, 8)} was left, so it moved to Being checked.` });
          out.held++;
        }
      } else if (t.systemState === "review" && t.checkHoldAt && own.has(t.id) && !job) {
        // The branch moved past the live check while its agent runs again: it is In progress work once more.
        const why = "Its agent started work on it again and the branch moved past the checked commit.";
        if (await systemMoveTicket(db, { ticketId: t.id, from: ["review"], to: "in_progress", reason: `Boss Man: ${why}`, now: now(), stateNote: why })) out.returned++;
      }
    }
    return out;
  }

  return {
    settle,
    /** A check job ended: settle its ticket if it is held. */
    onEnded: async (job: CheckJob) => {
      if (job.kind !== "pre_review") return;
      await settle(job.ticketId);
    },
    /** Every held ticket, for the sweep that catches an end this process never saw (a restart, a crash between the job and here). */
    sweepProgress,
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
