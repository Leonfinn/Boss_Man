// BOS-2357: a run that ends on an error is classed once, when it ends. A passing error (a stream or SSE
// read timeout, a reset connection, the model API overloaded or answering 5xx) is resumed by itself, the
// same way an interrupted run is, at most twice an hour per ticket. Past that, and for any other error,
// the CEO gets one card naming the error. Usage-limit and sign-in errors keep their own path (limit-requeue
// and the account card), and so do owner-chat runs. A deploy's run is never resumed (BOS-2362): one CEO card names the target.
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { activity, deployTargets, deploys, runs } from "../db/schema.js";
import { record } from "./activity.js";
import { accountOutage } from "./loop-guards.js";
import type { AlertInput } from "./alert-ladder.js";

export const RUN_ERROR_RESUME_KIND = "run_error_resume";
/** Automatic resumes allowed per ticket in the window. */
export const RUN_ERROR_RESUMES_PER_HOUR = 2;
const WINDOW_MS = 3_600_000;

/** The wording of errors that pass by themselves: stream and SSE read timeouts, resets, 5xx and overloaded (529). */
const TRANSIENT =
  /SSE read timed out|stream(?:ing)? (?:read )?(?:timed out|timeout|ended unexpectedly|closed)|read timed out|request timed out|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|connection (?:was )?(?:reset|closed|terminated|lost)|other side closed|fetch failed|overloaded|\b(?:status|code|error|http)[:\s]*(?:5\d\d)\b|\b5\d\d (?:internal server error|bad gateway|service unavailable|gateway timeout)|internal server error|bad gateway|service unavailable|gateway timeout|api_error/i;

export type RunErrorClass = "transient" | "account" | "other";

/** What kind of ending an `error:` outcome is. */
export function classifyRunError(error: string): RunErrorClass {
  const text = error.replace(/^error:\s*/i, "");
  if (accountOutage(text)) return "account";
  return TRANSIENT.test(text) ? "transient" : "other";
}

type Deps = {
  now: () => Date;
  /** recovery.onInterrupted: queues the resume wake. */
  resume: (runId: string) => Promise<unknown>;
  alert: (input: AlertInput) => Promise<{ id: string } | null>;
};

export function runErrorRetry(db: Db, deps: Deps) {
  return {
    /** Called once when a run ends on its own error (not interrupted). Resumes it or raises the CEO card. */
    async afterRun(runId: string): Promise<"resumed" | "card" | "skipped"> {
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run?.agentId || !run.outcome || !/^error:/i.test(run.outcome) || run.purpose === "chat") return "skipped";
      const kind = classifyRunError(run.outcome);
      if (kind === "account") return "skipped";
      const at = deps.now();
      const error = run.outcome.replace(/^error:\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 300);
      const scope = run.ticketId ? eq(activity.ticketId, run.ticketId) : and(sql`${activity.ticketId} is null`, eq(activity.agentId, run.agentId));
      const card = (question: string, key: string) =>
        deps.alert({
          companyId: run.companyId,
          kind: "repeated_failure",
          from: "ceo",
          ticketId: run.ticketId,
          about: [run.agentId],
          question,
          dedupeKey: key,
          ...(run.ticketId ? { clearWhen: [{ kind: "ticketDone" as const, ticketId: run.ticketId }] } : {}),
        });
      // BOS-2362: a deploy's run is never restarted by itself (steps may have half-run; only a new approval restarts it,
      // BOS-480). Whatever the error, the CEO gets one card naming the target. A deploy that already reported success is left alone.
      const [dep] = await db
        .select({ id: deploys.id, status: deploys.status, target: deployTargets.name })
        .from(deploys)
        .innerJoin(deployTargets, eq(deployTargets.id, deploys.targetId))
        .where(eq(deploys.runId, runId))
        .limit(1);
      if (dep) {
        if (dep.status === "succeeded") return "skipped";
        await card(
          `The deploy to ${dep.target} ended on an error and was not restarted, because a deploy step may have half run and only a new approval restarts it: ${error}`,
          `run-error:${runId}`,
        );
        return "card";
      }
      if (kind === "other") {
        await card(`A run ended on an error and Boss Man does not know it as a passing one, so it did not restart it: ${error}`, `run-error:${runId}`);
        return "card";
      }
      const recent = await db
        .select({ id: activity.id })
        .from(activity)
        .where(and(eq(activity.kind, RUN_ERROR_RESUME_KIND), scope, gt(activity.at, new Date(at.getTime() - WINDOW_MS))));
      if (recent.length >= RUN_ERROR_RESUMES_PER_HOUR) {
        await card(
          `Runs on this ticket ended on a passing error ${recent.length + 1} times in the last hour, and Boss Man resumes it only ${RUN_ERROR_RESUMES_PER_HOUR} times an hour, so it stopped. Latest error: ${error}`,
          `run-error-limit:${run.ticketId ?? run.agentId}:${Math.floor(at.getTime() / WINDOW_MS)}`,
        );
        return "card";
      }
      // onInterrupted answers null when it queues nothing (a deploy's run, BOS-480); that is not a resume and does not count.
      const woke = (await deps.resume(runId)) as { outcome?: string } | null;
      if (!woke || woke.outcome === "dropped") return "skipped";
      await record(db, { companyId: run.companyId, agentId: run.agentId, ticketId: run.ticketId, kind: RUN_ERROR_RESUME_KIND, summary: `Run ended on a passing error; resumed it: ${error}`, detail: { runId, error }, at });
      return "resumed";
    },
  };
}
