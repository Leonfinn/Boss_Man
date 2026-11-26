// An agent asks for a check of its ticket (request_check, DR-003, BOS-316).
// It reads the ticket's committed head and tree from the runner, queues a pre-review job, and says where it stands.
// The agent is woken with the result by the dispatcher (check_result), so it never polls.
import { and, desc, eq } from "drizzle-orm";
import type { WorkspaceDiff } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs, runners, tickets } from "../db/schema.js";
import { checkQueue, type CheckScope } from "./check-queue.js";
import { checkPriority } from "./check-gate.js";
import { checkPlace } from "./check-wording.js";
import { record } from "./activity.js";
import type { CiPreflight } from "./ci-preflight.js";

export class CheckRequestError extends Error {}

/** Activity kind of a request_check answered by an existing job (a pass on the same tree, or the ticket's live job). */
export const CHECK_REUSED_KIND = "check_reused";

export type CheckRequestDeps = {
  /** Ask the company's runner for the ticket's diff (workspace.diff). */
  diff: (runnerId: string, projectId: string, ticketId: string) => Promise<WorkspaceDiff>;
  /** Commands per scope, from the project's settings; a missing one falls back to the runner's default. */
  command?: (scope: CheckScope, projectId: string) => Promise<string | null>;
  /** GitHub's CI jobs before review for a branch that changes CI or image files (BOS-1664). */
  preflight?: CiPreflight;
};

/**
 * BOS-1922: the move to review waits for the quick check on the ticket's current head. Refused while the newest
 * pre-review check of that commit failed (a pass of any width on it lifts the hold). A head with no check at all, a
 * no-code ticket, or a runner that can't say what the head is: no hold.
 * BOS-2714: a queued or running check is refused only when the move can't be held as "Being checked" (BOS-1906): the
 * mover is not the assignee, or the ticket is not In progress. Otherwise the move goes ahead and holdForReview holds it on
 * that same job, which already keeps the reviews closed until it passes. Refusing it left finished work In progress.
 */
export async function quickCheckRefusal(db: Db, ticketId: string, diff: (t: typeof tickets.$inferSelect) => Promise<Pick<WorkspaceDiff, "head">>, mover?: string | null): Promise<string | null> {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t || t.noCode) return null;
  const holdable = !!mover && t.assigneeAgentId === mover && t.systemState === "in_progress";
  let head: string;
  try {
    head = (await diff(t)).head;
  } catch {
    return null;
  }
  if (!head) return null;
  const jobs = await db
    .select({ state: checkJobs.state })
    .from(checkJobs)
    .where(and(eq(checkJobs.ticketId, ticketId), eq(checkJobs.commit, head), eq(checkJobs.kind, "pre_review")))
    .orderBy(desc(checkJobs.queuedAt));
  if (!jobs.length || jobs.some((j) => j.state === "passed")) return null;
  const state = jobs[0]!.state;
  if (state !== "queued" && state !== "running" && state !== "failed") return null;
  if (state !== "failed" && holdable) return null;
  return `the quick check on ${head.slice(0, 8)} hasn't passed yet (${state}). It wakes you when it finishes; move to review then.`;
}

export function checkRequestService(db: Db, deps: CheckRequestDeps) {
  const queue = checkQueue(db);
  return {
    async request(input: { companyId: string; agentId: string; ticketId: string; scope?: CheckScope; ciNotApplicable?: string }): Promise<string> {
      const scope = input.scope ?? "quick";
      if ((await queue.mode()) !== "server") {
        throw new CheckRequestError("The check queue is not switched on yet, so run scripts/check-quick.sh yourself, from the repo root, as before.");
      }
      const [t] = await db.select().from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, input.companyId)));
      if (!t) throw new CheckRequestError("No such ticket.");
      if (t.assigneeAgentId !== input.agentId) throw new CheckRequestError("Only the ticket's assignee can ask for a check.");
      if (t.systemState !== "in_progress" && t.systemState !== "review") throw new CheckRequestError("A check can be asked for while the ticket is in progress or in review.");
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, input.companyId));
      if (!runner) throw new CheckRequestError("The company has no runner.");
      let d: WorkspaceDiff;
      try {
        d = await deps.diff(runner.id, t.projectId, t.id);
      } catch (err) {
        throw new CheckRequestError(`Couldn't read the ticket's work from the runner: ${(err as Error).message}`);
      }
      if (!d.tree) throw new CheckRequestError("The runner is too old to say which code the ticket holds. Ask the owner to update the runners.");
      if (d.files.length && !d.commits.length) throw new CheckRequestError("Nothing is committed yet: commit your work first, then ask again. A check runs on a commit.");
      // BOS-1544: the job would fail to start ("invalid reference"); say why now and queue nothing.
      if (d.unsynced) throw new CheckRequestError(`The runner couldn't copy your branch into its shared repo, so a check of it can't start, and nothing was queued (${d.unsynced}). Your code isn't at fault. If the reason says how to fix it, do that and ask again; if it's a runner error, don't requeue: tell the CEO with this message.`);
      // BOS-1664: a branch that changes CI or image files also gets GitHub's own jobs run on it, merged with main.
      const pre = await deps.preflight?.start(t, input.agentId, d, input.ciNotApplicable).catch((err: Error) => `GitHub's CI jobs could not be started (${err.message}); the move to review will say what is still needed.`);
      const extra = pre ? `\n\n${pre}` : "";
      const { job, reused } = await queue.enqueue({
        companyId: input.companyId,
        projectId: t.projectId,
        ticketId: t.id,
        kind: "pre_review",
        scope,
        commit: d.head,
        tree: d.tree,
        command: (await deps.command?.(scope, t.projectId)) ?? null,
        priority: checkPriority(t),
        requestedBy: input.agentId,
      });
      if (reused) {
        // A reused request makes no check_jobs row, so this is the only trace of it for the check-line export (BOS-1309).
        // No agent on the row, so per-agent activity counts never see it; the brief skips the kind. Never fails the request.
        await record(db, {
          companyId: input.companyId,
          ticketId: t.id,
          kind: CHECK_REUSED_KIND,
          summary: `Check request answered by ${reused === "passed" ? "an earlier pass" : "a check already in line"} (${job.scope})`,
          detail: { reused, scope, outcome: job.state },
        }).catch(() => {});
      }
      const uncommitted = (d.files.length && d.head ? " Anything you have not committed is not in this check." : "") + (t.systemState === "in_progress" && scope === "quick" ? " If your code is finished, move the ticket to review now instead of waiting in In progress: Boss Man holds it as \"Being checked\" and opens the reviews on a pass." : "");
      if (reused === "passed") return `Already answered: the same code (commit ${job.commit.slice(0, 8)}) passed a ${job.scope} check, so nothing was queued.${uncommitted}${extra}`;
      // BOS-1412: the same code already waits (or runs). Hand back that job and where it stands; it is not re-queued,
      // so the agent reading its place never sends it to the back of the line.
      if (reused === "live") return `Nothing new was queued: your ${job.scope} check of commit ${job.commit.slice(0, 8)} is already ${await checkPlace(queue, input.companyId, job)}, and its result will wake you. End your turn or carry on with other work; do not poll or start your own background loop.${uncommitted}${extra}`;
      const st = await queue.status(input.companyId);
      const place = st.queued.find((q) => q.id === job.id)?.place;
      const where = job.state === "running" ? "It is running now." : place ? `It is number ${place} in line.` : "It is waiting (a red main holds back some checks).";
      return `A ${job.scope} check of commit ${job.commit.slice(0, 8)} is queued. ${where} You will be woken with the result, so end your turn or carry on with other work; do not poll or start your own background loop.${uncommitted}${extra}`;
    },

    /**
     * BOS-1906: an agent hands a ticket in to review. With no passing quick check on its head, the check is queued here and the
     * ticket is to wait in review as "Being checked" (held: true; `where` says its place). A same-code pass, a queue that is off,
     * or anything that can't be read leaves held false, so the move to review opens the reviews as it always did. The job carries no
     * requestedBy: a pass opens the review slots (no agent run in between); a failure wakes the agent from the hold sweep.
     */
    async holdForReview(input: { companyId: string; agentId: string | null; ticketId: string }): Promise<{ held: false } | { held: true; where: string }> {
      const no = { held: false } as const;
      try {
        if (!input.agentId || (await queue.mode()) !== "server") return no;
        const [t] = await db.select().from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, input.companyId)));
        if (!t || t.assigneeAgentId !== input.agentId || t.noCode || t.systemState !== "in_progress") return no;
        const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, input.companyId));
        if (!runner) return no;
        const d = await deps.diff(runner.id, t.projectId, t.id);
        if (!d.tree || !d.head || !d.commits.length || d.unsynced) return no;
        const { job, reused } = await queue.enqueue({
          companyId: input.companyId,
          projectId: t.projectId,
          ticketId: t.id,
          kind: "pre_review",
          scope: "quick",
          commit: d.head,
          tree: d.tree,
          command: (await deps.command?.("quick", t.projectId)) ?? null,
          priority: checkPriority(t),
          requestedBy: null,
        });
        if (reused === "passed") return no;
        // BOS-2714: the live job the agent asked for (request_check) now answers the hand-in. Its result belongs to the hold:
        // a pass opens the reviews with no agent run, and a failure wakes the agent once, from the hold's bounce.
        if (reused === "live" && job.requestedBy) await db.update(checkJobs).set({ requestedBy: null }).where(eq(checkJobs.id, job.id));
        return { held: true, where: await checkPlace(queue, input.companyId, job) };
      } catch {
        return no;
      }
    },

    /** BOS-1664: the move to review is refused while GitHub's CI jobs for a CI or image change haven't passed (or been marked not applicable). */
    async reviewRefusal(companyId: string, ticketId: string, mover?: string | null): Promise<string | null> {
      // With the queue off, request_check refuses, so a hold on it could never be lifted: no hold.
      if ((await queue.mode()) !== "server") return null;
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
      if (!runner) return null;
      const head = new Map<string, Promise<Pick<WorkspaceDiff, "head" | "files">>>();
      const diff = (t: typeof tickets.$inferSelect) => {
        if (!head.has(t.id)) head.set(t.id, deps.diff(runner.id, t.projectId, t.id));
        return head.get(t.id)!;
      };
      const quick = await quickCheckRefusal(db, ticketId, diff, mover);
      if (quick) return quick;
      return deps.preflight ? deps.preflight.reviewRefusal(ticketId, diff) : null;
    },
  };
}
