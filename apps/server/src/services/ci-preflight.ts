// BOS-1664 (R30 part 1): GitHub's own CI jobs on a branch that changes CI or image files, before review.
// request_check starts it: the branch merged with main goes to bossman-ci/<ticket> (the gate's push, ci-publish.ts), GitHub's
// run is read, and the result is kept (check_results kind "ci_preflight"), told on the ticket and sent in a wake. The move to
// review is refused until the run for the branch's current head passed, or the author marked the job not applicable with a reason.
import { and, desc, eq } from "drizzle-orm";
import type { MergeResult, WorkspaceDiff } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { checkJobs, checkResults, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { CI_TIMING, CiPublishError, needsEarlyGithubRun, publishAndWait, touchesGithubOnlyJobs, touchesWorkflows, type CiOutcome, type CiTarget, type CiTiming } from "./ci-publish.js";
import type { gitHostService } from "./git-hosts.js";

export const PREFLIGHT_KIND = "ci_preflight";
export const PREFLIGHT_NA_KIND = "ci_preflight_na";
/** A run was started for this sha (detail: the agent to wake); with no PREFLIGHT_KIND row after it, a restart lost the run. */
export const PREFLIGHT_STARTED_KIND = "ci_preflight_started";
export const PREFLIGHT_ACTIVITY = "ci_preflight";
/** BOS-2284: GitHub's run for this sha waits for the local quick check on it to pass (detail: the agent to wake). */
export const PREFLIGHT_WAITING_KIND = "ci_preflight_waiting";
/** BOS-2284: the quick check on this sha did not pass, so GitHub's run was never started (kept so the skip is recorded once). */
export const PREFLIGHT_SKIPPED_KIND = "ci_preflight_skipped";

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
  log?: (line: string) => void;
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
      // Only the merge gate sets known_red (R40); the pre-flight never sees it, and a failure is never a pass here.
      case "known_red":
        return { passed: false, text: `GitHub's CI jobs failed on your branch merged with main (${merge}) in ${o.jobs.join(", ")}, which also fails on main.` };
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

  /**
   * BOS-2284: the ticket's quick-check jobs for one commit, newest first. The queue reuses a pass by tree (any ticket in the
   * project), so a job on the same tree stands in for the commit; `tree` adds that case. The waiting row keeps the tree as
   * "<agent>|<tree>" in its detail (older rows hold the agent only).
   */
  const quickJobs = async (t: { id: string; projectId: string }, sha: string, tree?: string | null) => {
    const own = db.select({ state: checkJobs.state, reason: checkJobs.reason }).from(checkJobs).where(and(eq(checkJobs.ticketId, t.id), eq(checkJobs.kind, "pre_review"), eq(checkJobs.commit, sha))).orderBy(desc(checkJobs.queuedAt));
    const rows = await own;
    if (!tree) return rows;
    const same = await db
      .select({ state: checkJobs.state, reason: checkJobs.reason, ticketId: checkJobs.ticketId })
      .from(checkJobs)
      .where(and(eq(checkJobs.projectId, t.projectId), eq(checkJobs.tree, tree), eq(checkJobs.kind, "pre_review")))
      .orderBy(desc(checkJobs.queuedAt));
    // A pass anywhere on the tree counts; a failure or live job counts only when it is this ticket's own.
    return [...rows, ...same.filter((j) => j.state === "passed" || j.ticketId === t.id)];
  };
  const parseWaiting = (detail: string) => {
    const [agentId = "", tree = ""] = detail.split("|");
    return { agentId, tree: tree || null };
  };

  /**
   * BOS-2284: a run waiting for its commit's quick check. Passed: start it now. Failed, stuck or cancelled: don't start it, and say
   * so on the ticket (once). Still queued or running: keep waiting. Safe to call any number of times.
   */
  async function settleWaiting(ticketId: string): Promise<"started" | "skipped" | "waiting" | "none"> {
    const w = await latest(ticketId, PREFLIGHT_WAITING_KIND);
    if (!w?.sha || !w.detail) return "none";
    for (const k of [PREFLIGHT_STARTED_KIND, PREFLIGHT_KIND, PREFLIGHT_NA_KIND, PREFLIGHT_SKIPPED_KIND]) {
      const r = await latest(ticketId, k, w.sha);
      if (r && r.at >= w.at) return "none"; // already dealt with
    }
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!t || (t.systemState !== "in_progress" && t.systemState !== "review")) return "none";
    const { agentId, tree } = parseWaiting(w.detail);
    const jobs = await quickJobs(t, w.sha, tree);
    if (jobs.some((j) => j.state === "passed")) {
      if (running.get(ticketId)?.head === w.sha) return "none";
      const ctx = await deps.context(t).catch(() => null);
      if (!ctx) return "waiting"; // no runner yet: the recovery sweep tries again
      launch(t, agentId, w.sha, ctx);
      await record(db, { companyId: t.companyId, ticketId, kind: PREFLIGHT_ACTIVITY, summary: `The quick check passed on ${short(w.sha)}, so GitHub's CI jobs were started for it.` }).catch(() => undefined);
      return "started";
    }
    const last = jobs[0];
    if (!last || last.state === "queued" || last.state === "running") return "waiting";
    await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: w.sha, kind: PREFLIGHT_SKIPPED_KIND, passed: false, detail: `quick check ${last.state}` });
    await record(db, { companyId: t.companyId, ticketId, kind: PREFLIGHT_ACTIVITY, summary: `GitHub's CI jobs before review were NOT started for ${short(w.sha)}: the quick check on that commit ${last.state === "failed" ? "failed" : `did not pass (${last.state})`}. Fix it and commit; GitHub's run starts once the quick check passes on the new commit (ask again with request_check).` }).catch(() => undefined);
    return "skipped";
  }

  return {
    /** BOS-2284: a pre-review check job ended: start or drop the GitHub run that waited for it. */
    async onQuickEnded(job: { kind: string; ticketId: string }): Promise<void> {
      if (job.kind !== "pre_review") return;
      await settleWaiting(job.ticketId);
    },

    /**
     * After a server restart: a run that started (row) but has no result (row) lost its in-memory run, and the author was told
     * to wait for a wake that would never come. Start those again. Safe to call twice: a run in memory is skipped.
     */
    async recover(): Promise<{ launched: number; skipped: number; skippedIds: string[] }> {
      const skippedIds: string[] = [];
      const started = await db.select().from(checkResults).where(eq(checkResults.kind, PREFLIGHT_STARTED_KIND)).orderBy(desc(checkResults.at)).limit(200);
      let n = 0;
      let skipped = 0;
      const seen = new Set<string>();
      for (const s of started) {
        if (seen.has(s.ticketId) || !s.sha || !s.detail) continue;
        seen.add(s.ticketId); // only the newest start per ticket matters
        if (running.has(s.ticketId)) continue;
        if (await latest(s.ticketId, PREFLIGHT_KIND, s.sha)) continue;
        const [t] = await db.select().from(tickets).where(eq(tickets.id, s.ticketId));
        if (!t || (t.systemState !== "in_progress" && t.systemState !== "review")) continue;
        const ctx = await deps.context(t).catch((err) => {
          deps.log?.(`GitHub CI pre-check recovery: could not set up ticket ${short(t.id)}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
        if (!ctx) {
          skipped++;
          skippedIds.push(t.id); // no runner connected yet (or GitHub CI can't be used): a later try may find one
          continue;
        }
        launch(t, s.detail, s.sha, ctx);
        n++;
      }
      // BOS-2284: runs that waited for a quick check whose end this process never saw (a restart in between).
      const waiting = await db.select({ ticketId: checkResults.ticketId }).from(checkResults).where(eq(checkResults.kind, PREFLIGHT_WAITING_KIND)).orderBy(desc(checkResults.at)).limit(200);
      for (const id of new Set(waiting.map((x) => x.ticketId))) {
        const r = await settleWaiting(id).catch(() => "none" as const);
        if (r === "started") n++;
      }
      deps.log?.(`GitHub CI pre-check recovery: ${n} relaunched, ${skipped} skipped (no runner connected yet)`);
      return { launched: n, skipped, skippedIds };
    },

    /**
     * recover() now, then again every `everyMs` while some ticket was skipped, until `forMs` has passed. A runner that
     * reconnects after the first try is found on a later one. Returns a function that stops it.
     */
    recoverRepeatedly(o: { firstMs: number; everyMs: number; forMs: number }): () => void {
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      const tick = async () => {
        let again = false;
        let pending: string[] = [];
        try {
          const r = await this.recover();
          pending = r.skippedIds;
          again = r.skipped > 0;
        } catch (err) {
          deps.log?.(`GitHub CI pre-check recovery failed: ${err instanceof Error ? err.message : String(err)}`);
          again = true;
        }
        if (stopped || !again) return;
        if (Date.now() - startedAt + o.everyMs > o.forMs) {
          deps.log?.(`GitHub CI pre-check recovery: giving up after ${Math.round(o.forMs / 60000)} min; still skipped: ${pending.map(short).join(", ") || "none named (setup failed)"}`);
          return;
        }
        timer = setTimeout(() => void tick(), o.everyMs);
        timer.unref();
      };
      timer = setTimeout(() => void tick(), o.firstMs);
      timer.unref();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },

    /**
     * Called by request_check with the branch's diff. Returns a sentence to add to the answer, or null when the branch changes
     * nothing GitHub-only (or GitHub CI can't be used for this project). `notApplicable` is the author's reason for skipping it.
     */
    async start(t: { id: string; companyId: string; projectId: string }, agentId: string, d: Pick<WorkspaceDiff, "head" | "tree" | "files">, notApplicable?: string): Promise<string | null> {
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
      // BOS-2284: GitHub's run starts only once the local quick check has passed on this exact commit.
      const tree = d.tree;
      if (!(await quickJobs(t, d.head, tree)).some((j) => j.state === "passed")) {
        const w = await latest(t.id, PREFLIGHT_WAITING_KIND, d.head);
        if (!w) await db.insert(checkResults).values({ companyId: t.companyId, ticketId: t.id, sha: d.head, kind: PREFLIGHT_WAITING_KIND, passed: false, detail: tree ? `${agentId}|${tree}` : agentId });
        return "This branch changes CI or image files, so GitHub's own CI jobs run on it too, but only after your quick check passes on this exact commit (a red GitHub run on unfinished work only sends the owner a failure notice). If the quick check fails, GitHub's run is skipped and the ticket says so. The ticket can't move to review until both pass. You will be woken with each result; do not poll. If GitHub's jobs truly don't apply, ask again with ciNotApplicable and a reason.";
      }
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
      const w = await latest(t.id, PREFLIGHT_WAITING_KIND, d.head);
      if (w && !r) {
        const skipped = await latest(t.id, PREFLIGHT_SKIPPED_KIND, d.head);
        return skipped
          ? "GitHub's CI jobs were not started because the quick check on this commit did not pass. Fix it, commit, and run request_check again."
          : "GitHub's CI jobs start as soon as the quick check passes on this commit. Wait to be woken, then move it to review.";
      }
      return r
        ? `GitHub's CI jobs did not pass on this commit: ${r.detail ?? "see the ticket"}. Fix it, commit, and run request_check again.`
        : "This branch changes CI or image files, so GitHub's own CI jobs must pass before review. Commit, then run request_check (it starts them and wakes you with the result). If they truly don't apply, run request_check with ciNotApplicable and a reason.";
    },
  };
}
export type CiPreflight = ReturnType<typeof ciPreflightService>;
