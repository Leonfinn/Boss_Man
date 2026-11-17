// BOS-1664 (R30 part 1): GitHub's own CI jobs on a branch that changes CI or image files, before review.
// request_check starts it: the branch merged with main goes to bossman-ci/<ticket> (the gate's push, ci-publish.ts), GitHub's
// run is read, and the result is kept (check_results kind "ci_preflight"), told on the ticket and sent in a wake. The move to
// review is refused until the run for the branch's current head passed, or the author marked the job not applicable with a reason.
import { and, desc, eq } from "drizzle-orm";
import type { MergeResult, WorkspaceDiff } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkResults, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { CI_TIMING, CiPublishError, needsEarlyGithubRun, publishAndWait, touchesGithubOnlyJobs, touchesWorkflows, type CiOutcome, type CiTarget, type CiTiming } from "./ci-publish.js";
import type { gitHostService } from "./git-hosts.js";

export const PREFLIGHT_KIND = "ci_preflight";
export const PREFLIGHT_NA_KIND = "ci_preflight_na";
/** A run was started for this sha (detail: the agent to wake); with no PREFLIGHT_KIND row after it, a restart lost the run. */
export const PREFLIGHT_STARTED_KIND = "ci_preflight_started";
export const PREFLIGHT_ACTIVITY = "ci_preflight";

/** What the service needs from the project's host and runner; null: GitHub CI can't be used here, so nothing is asked or refused. */
export type PreflightContext = {
  target: CiTarget;
  /** workspace.merge phase "prepare": the branch merged with main, kept, not pushed. */
  prepare: () => Promise<MergeResult>;
  /** workspace.merge phase "publish": push that commit to bossman-ci/<ticket>. */
  publish: (commit: string) => Promise<MergeResult>;
  /** Phase "unpublish", best effort. */
  unpublish: () => Promise<unknown>;
};

export type PreflightDeps = {
  hosts: Pick<ReturnType<typeof gitHostService>, "ciStatus" | "failures" | "workflowRuns" | "rerunRun">;
  context: (ticket: { id: string; companyId: string; projectId: string }) => Promise<PreflightContext | null>;
  wake?: (agentId: string, w: { ticketId: string; reason: string; note: string; priority?: number }) => PromiseLike<unknown> | unknown;
  timing?: CiTiming;
};

const short = (s: string) => s.slice(0, 8);

export function ciPreflightService(db: Db, deps: PreflightDeps) {
  // ticket → head being run and its promise; lost on restart, so a "started" row is kept and recover() restarts the run.
  const running = new Map<string, { head: string; done: Promise<void> }>();
  const timing = deps.timing ?? CI_TIMING;

  const latest = async (ticketId: string, kind: string, sha?: string) => {
    const rows = await db.select().from(checkResults).where(and(eq(checkResults.ticketId, ticketId), eq(checkResults.kind, kind))).orderBy(desc(checkResults.at)).limit(20);
    return rows.find((r) => !sha || r.sha === sha);
  };

  async function words(ctx: PreflightContext, o: CiOutcome, merge: string): Promise<{ passed: boolean; text: string }> {
    switch (o.kind) {
      case "passed":
        return { passed: true, text: `GitHub's CI jobs passed on your branch merged with main (${merge}).` };
      case "no_workflows":
        return { passed: true, text: "The merged result has no GitHub workflows, so there are no GitHub-only jobs to run." };
      case "none":
        return { passed: true, text: "GitHub did not start CI for the pushed branch (the workflow may not run on bossman-ci/** branches), so there is nothing to wait for." };
      case "stopped":
        return { passed: false, text: "The run was stopped." };
      case "timeout":
        return { passed: false, text: `GitHub CI was still running after ${Math.round(timing.ceilingMs / 60_000)} minutes${o.waiting.length ? ` (${o.waiting.join(", ")})` : ""}. Ask again with request_check later, or tell the CEO.` };
      case "refused":
        return { passed: false, text: `Boss Man can't read GitHub's CI runs for this project (${o.message}). That is the git token's access, not your code: tell the CEO, or mark the job not applicable with a reason if it truly doesn't apply.` };
      case "error":
        return { passed: false, text: `GitHub's CI result couldn't be read (${o.message}). Ask again later; if it keeps happening, tell the CEO.` };
      case "superseded":
        return { passed: false, text: `GitHub replaced this CI run with a newer one on the same branch (${short(o.newerSha)}), so no test failed. Ask again with request_check.` };
      case "cancelled":
        return { passed: false, text: `GitHub cancelled the CI run${o.runs.length ? ` (${o.runs.join(", ")})` : ""}${o.rerunTried ? " again after one re-run" : ""}, so no test failed. Ask again with request_check; if it keeps happening, tell the CEO.` };
      case "failed": {
        const found = await deps.hosts.failures(ctx.target.cfg, ctx.target.token, o.status.failed).catch(() => []);
        const listed = found.length ? found : o.status.failed.map((run) => ({ run, lines: [] as string[] }));
        const body = listed.length
          ? listed.map((f) => `- ${f.run.name}${f.run.url ? ` (${f.run.url})` : ""}${f.lines.length ? `\n${f.lines.map((l) => `  - ${l}`).join("\n")}` : ""}`).join("\n")
          : "- the workflow failed before any job ran; open the commit's checks on GitHub";
        return { passed: false, text: `GitHub's CI jobs failed on your branch merged with main (${merge}):\n${body}\n\nFix them on your branch, commit, and ask again with request_check.` };
      }
    }
  }

  async function run(t: { id: string; companyId: string; projectId: string }, agentId: string, head: string, ctx: PreflightContext) {
    let passed = false;
    let text: string;
    try {
      const prep = await ctx.prepare();
      if (prep.status === "conflicts") {
        text = `Your branch doesn't merge cleanly with main (${prep.files.join(", ") || "conflicts"}), so GitHub's CI can't be run on it. Merge origin/main into your branch, fix the clash, commit, and ask again.`;
      } else if (prep.status !== "prepared") {
        text = `GitHub's CI could not be run: the merge with main answered "${prep.status}". Commit everything, then ask again.`;
      } else {
        const outcome = await publishAndWait(
          { hosts: deps.hosts, target: ctx.target, timing, publish: ctx.publish, announce: async (branch) => void (await record(db, { companyId: t.companyId, ticketId: t.id, kind: PREFLIGHT_ACTIVITY, summary: `Pushed your branch merged with main (${short(prep.commit)}) to ${branch} for GitHub's CI jobs. Nothing to do; you are woken with the result.` })) },
          prep,
          { stopped: false },
        );
        const w = await words(ctx, outcome, short(prep.commit));
        passed = w.passed;
        text = w.text;
      }
    } catch (err) {
      text = err instanceof CiPublishError ? err.message : `GitHub's CI run could not be started: ${(err as Error).message}`;
    }
    await db.insert(checkResults).values({ companyId: t.companyId, ticketId: t.id, sha: head, kind: PREFLIGHT_KIND, passed, detail: text.slice(0, 1000) });
    await record(db, { companyId: t.companyId, ticketId: t.id, kind: PREFLIGHT_ACTIVITY, summary: `GitHub CI before review: ${passed ? "passed" : "failed"} for commit ${short(head)}. ${text.slice(0, 600)}` }).catch(() => undefined);
    await Promise.resolve(deps.wake?.(agentId, { ticketId: t.id, reason: "check_result", note: `GitHub CI before review (commit ${short(head)}): ${passed ? "passed" : "FAILED"}.\n${text}`, priority: 2 })).catch(() => undefined);
  }

  /**
   * Starts a run and records that it started (a row that survives a restart, see recover). A run for a newer head waits for
   * the older head's run on the same ticket, so two runs never share the one bossman-ci/<ticket> branch. The branch is removed
   * whether the run ended or threw.
   */
  function launch(t: { id: string; companyId: string; projectId: string }, agentId: string, head: string, ctx: PreflightContext) {
    const before = running.get(t.id)?.done ?? Promise.resolve();
    const done: Promise<void> = before
      .then(async () => {
        await db.insert(checkResults).values({ companyId: t.companyId, ticketId: t.id, sha: head, kind: PREFLIGHT_STARTED_KIND, passed: false, detail: agentId });
        await run(t, agentId, head, ctx);
      })
      .catch(() => undefined)
      .finally(async () => {
        await ctx.unpublish().catch(() => undefined);
        if (running.get(t.id)?.done === done) running.delete(t.id);
      });
    running.set(t.id, { head, done });
  }

  return {
    /**
     * After a server restart: a run that started (row) but has no result (row) lost its in-memory run, and the author was told
     * to wait for a wake that would never come. Start those again. Safe to call twice: a run in memory is skipped.
     */
    async recover(): Promise<number> {
      const started = await db.select().from(checkResults).where(eq(checkResults.kind, PREFLIGHT_STARTED_KIND)).orderBy(desc(checkResults.at)).limit(200);
      let n = 0;
      const seen = new Set<string>();
      for (const s of started) {
        if (seen.has(s.ticketId) || !s.sha || !s.detail) continue;
        seen.add(s.ticketId); // only the newest start per ticket matters
        if (running.has(s.ticketId)) continue;
        if (await latest(s.ticketId, PREFLIGHT_KIND, s.sha)) continue;
        const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId));
        if (!t || (t.systemState !== "in_progress" && t.systemState !== "review")) continue;
        const ctx = await deps.context(t).catch(() => null);
        if (!ctx) continue;
        launch(t, s.detail, s.sha, ctx);
        n++;
      }
      return n;
    },

    /**
     * Called by request_check with the branch's diff. Returns a sentence to add to the answer, or null when the branch changes
     * nothing GitHub-only (or GitHub CI can't be used for this project). `notApplicable` is the author's reason for skipping it.
     */
    async start(t: { id: string; companyId: string; projectId: string }, agentId: string, d: Pick<WorkspaceDiff, "head" | "files">, notApplicable?: string): Promise<string | null> {
      const paths = d.files.map((f) => f.path);
      if (!touchesGithubOnlyJobs(paths)) return null;
      if (touchesWorkflows(paths)) return "This branch edits GitHub workflow files. Those are not pushed to GitHub before review (GitHub would run an unreviewed workflow with its own token); they run once, at the merge gate, after the reviews. Nothing is held for them.";
      const ctx = await deps.context(t);
      if (!ctx) return null;
      const reason = notApplicable?.trim();
      if (reason) {
        await db.insert(checkResults).values({ companyId: t.companyId, ticketId: t.id, sha: d.head, kind: PREFLIGHT_NA_KIND, passed: true, detail: reason.slice(0, 500) });
        await record(db, { companyId: t.companyId, ticketId: t.id, kind: PREFLIGHT_ACTIVITY, summary: `The author marked GitHub's CI jobs before review as not applicable: ${reason.slice(0, 300)}` }).catch(() => undefined);
        return "GitHub's CI jobs are marked not applicable with your reason; the move to review is no longer held for them.";
      }
      if (running.get(t.id)?.head === d.head) return "GitHub's CI jobs for this commit are already running; you will be woken with the result.";
      const done = await latest(t.id, PREFLIGHT_KIND, d.head);
      if (done?.passed) return `GitHub's CI jobs already passed on this commit, so none were started.`;
      launch(t, agentId, d.head, ctx);
      return "This branch changes CI or image files, so GitHub's own CI jobs run on it merged with main as well (this can take a while). The ticket can't move to review until they pass. You will be woken with the result; do not poll. If they truly don't apply, ask again with ciNotApplicable and a reason.";
    },

    /** The move to review: a reason to refuse it (plain words), or null. `diff` reads the branch from the runner. */
    async reviewRefusal(ticketId: string, diff: (t: typeof tickets.$inferSelect) => Promise<Pick<WorkspaceDiff, "head" | "files">>): Promise<string | null> {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) return null;
      // Cheap database checks first: a project that can't run GitHub jobs never costs a runner round trip.
      if (!(await deps.context(t))) return null;
      let d: Pick<WorkspaceDiff, "head" | "files">;
      try {
        d = await diff(t);
      } catch {
        return null; // can't tell: carry on, the gate's own run at landing still stands
      }
      if (!needsEarlyGithubRun(d.files.map((f) => f.path))) return null;
      // The mark covers this commit only: a later commit re-arms the hold.
      if (await latest(t.id, PREFLIGHT_NA_KIND, d.head)) return null;
      const r = await latest(t.id, PREFLIGHT_KIND, d.head);
      if (r?.passed) return null;
      if (running.get(t.id)?.head === d.head) return "GitHub's CI jobs are still running on this branch. Wait for the result (you are woken), then move it to review.";
      return r
        ? `GitHub's CI jobs did not pass on this commit: ${r.detail ?? "see the ticket"}. Fix it, commit, and run request_check again.`
        : "This branch changes CI or image files, so GitHub's own CI jobs must pass before review. Commit, then run request_check (it starts them and wakes you with the result). If they truly don't apply, run request_check with ciNotApplicable and a reason.";
    },
  };
}
export type CiPreflight = ReturnType<typeof ciPreflightService>;
