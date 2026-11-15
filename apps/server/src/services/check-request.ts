// An agent asks for a check of its ticket (request_check, DR-003, BOS-316).
// It reads the ticket's committed head and tree from the runner, queues a pre-review job, and says where it stands.
// The agent is woken with the result by the dispatcher (check_result), so it never polls.
import { and, eq } from "drizzle-orm";
import type { WorkspaceDiff } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { runners, tickets } from "../db/schema.js";
import { checkQueue, type CheckScope } from "./check-queue.js";
import { checkPriority } from "./check-gate.js";
import { checkPlace } from "./check-wording.js";
import { record } from "./activity.js";

export class CheckRequestError extends Error {}

/** Activity kind of a request_check answered by an existing job (a pass on the same tree, or the ticket's live job). */
export const CHECK_REUSED_KIND = "check_reused";

export type CheckRequestDeps = {
  /** Ask the company's runner for the ticket's diff (workspace.diff). */
  diff: (runnerId: string, projectId: string, ticketId: string) => Promise<WorkspaceDiff>;
  /** Commands per scope, from the project's settings; a missing one falls back to the runner's default. */
  command?: (scope: CheckScope, projectId: string) => Promise<string | null>;
};

export function checkRequestService(db: Db, deps: CheckRequestDeps) {
  const queue = checkQueue(db);
  return {
    async request(input: { companyId: string; agentId: string; ticketId: string; scope?: CheckScope }): Promise<string> {
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
      if (d.unsynced) throw new CheckRequestError(`The runner couldn't copy your branch into its shared repo, so a check of it can't start (${d.unsynced}). This is a runner fault, not your code: nothing was queued. Don't requeue; tell the CEO with this message.`);
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
      const uncommitted = d.files.length && d.head ? " Anything you have not committed is not in this check." : "";
      if (reused === "passed") return `Already answered: the same code (commit ${job.commit.slice(0, 8)}) passed a ${job.scope} check, so nothing was queued.${uncommitted}`;
      // BOS-1412: the same code already waits (or runs). Hand back that job and where it stands; it is not re-queued,
      // so the agent reading its place never sends it to the back of the line.
      if (reused === "live") return `Nothing new was queued: your ${job.scope} check of commit ${job.commit.slice(0, 8)} is already ${await checkPlace(queue, input.companyId, job)}, and its result will wake you. End your turn or carry on with other work; do not poll or start your own background loop.${uncommitted}`;
      const st = await queue.status(input.companyId);
      const place = st.queued.find((q) => q.id === job.id)?.place;
      const where = job.state === "running" ? "It is running now." : place ? `It is number ${place} in line.` : "It is waiting (a red main holds back some checks).";
      return `A ${job.scope} check of commit ${job.commit.slice(0, 8)} is queued. ${where} You will be woken with the result, so end your turn or carry on with other work; do not poll or start your own background loop.${uncommitted}`;
    },
  };
}
