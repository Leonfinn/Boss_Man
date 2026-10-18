// Review (R39): the review state carries the ticket's diff against its base, line comments
// go back to the agent as one message, and commit and PR steps are prompts from templates
// the owner can edit. Approving finishes the ticket until the merge step (R46) exists.
import { and, eq, isNotNull } from "drizzle-orm";
import { deepChecks, DEFAULT_GIT_TEMPLATES, formatReviewComments, ownerReviews, parseRepoUrl, renderTemplate, riskOf, type GitHostKind, type MergeResult, type PushResult, type ReviewComment, type VerifyResult, type WorkspaceDiff } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, decisions, projects, runners, settings, ticketDependencies, tickets } from "../db/schema.js";
import type { runnersService } from "./runners.js";
import type { workService } from "./work.js";
import { DIFFERENT_APPROACH, type loopGuards } from "./loop-guards.js";
import { GitHostError, type GitHostConfig, type gitHostService } from "./git-hosts.js";
import type { notificationsService } from "./notifications.js";

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type GitTemplates = { commit: string; pr: string };
type NotifyHook = (agentId: string, input: { reason: string; note: string; ticketId?: string | null; priority?: number; causedByRunId?: string | null }) => Promise<unknown>;

export function reviewService(
  db: Db,
  deps: {
    runners: ReturnType<typeof runnersService>;
    work: ReturnType<typeof workService>;
    loops: ReturnType<typeof loopGuards>;
    /** Pull requests on the git host (R59), with the company's GIT_TOKEN. */
    gitHosts?: ReturnType<typeof gitHostService>;
    gitToken?: (companyId: string) => Promise<string | undefined>;
    notes?: Pick<ReturnType<typeof notificationsService>, "notify">;
  },
) {
  let wake: NotifyHook | null = null;

  async function ticketWithRepo(ticketId: string, companyId?: string) {
    const [row] = await db
      .select({
        t: tickets,
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        verifyCommand: projects.verifyCommand,
        deepVerifyCommand: projects.deepVerifyCommand,
        landing: projects.landing,
        gitHost: projects.gitHost,
        gitApiBase: projects.gitApiBase,
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticketId));
    if (!row || (companyId && row.t.companyId !== companyId)) throw new ReviewError(404, "No such ticket.");
    return row;
  }

  /** The host and token for a pull request; without either, approval stops with what to set (R59). */
  async function prTarget(companyId: string, repoUrl: string | null, gitHost: string | null, gitApiBase: string | null): Promise<{ cfg: GitHostConfig; token: string }> {
    const a = repoUrl ? parseRepoUrl(repoUrl) : null;
    if (!deps.gitHosts || !a || (gitHost !== "gitea" && gitHost !== "github") || !gitApiBase)
      throw new ReviewError(409, "Boss Man doesn't know this project's git host, so it can't open a pull request. Set the host in the project's settings, or land work by merging.");
    const token = await deps.gitToken?.(companyId);
    if (!token) throw new ReviewError(409, "Grant the company a GIT_TOKEN secret that can push and open pull requests, then approve again.");
    return { cfg: { kind: gitHost as GitHostKind, apiBase: gitApiBase, owner: a.owner, repo: a.repo }, token };
  }

  async function finishMerged(t: typeof tickets.$inferSelect, commit: string | null) {
    await db.update(tickets).set({ mergeCommit: commit, pullRequestNote: null }).where(eq(tickets.id, t.id));
    await deps.work.updateTicket(t.id, { state: "done", outcome: "completed", overLimit: true });
    return { outcome: "merged" as const, delivered: null, detail: { commit } };
  }

  /** The ticket stays in review with the host's reason; the owner hears once per new reason. */
  async function wait(t: typeof tickets.$inferSelect, note: string) {
    const changed = note !== t.pullRequestNote;
    await db.update(tickets).set({ pullRequestNote: note }).where(eq(tickets.id, t.id));
    if (changed)
      await deps.notes?.notify({
        companyId: t.companyId,
        agentId: null,
        level: "note",
        title: `Pull request waiting: ${t.title}`,
        body: `${note}${t.pullRequestUrl ? `\n${t.pullRequestUrl}` : ""}`,
        link: `#/tickets/${t.id}`,
      });
    return { outcome: "pull_request" as const, delivered: null, detail: { note, url: t.pullRequestUrl } };
  }

  /** Tells the ticket's assignee: into its live run if it has one, otherwise by waking it (notify decides). */
  async function tellAgent(ticket: typeof tickets.$inferSelect, text: string, reason: string, causedByRunId?: string | null) {
    if (!ticket.assigneeAgentId || !wake) throw new ReviewError(409, "The ticket has no assignee to send this to.");
    const w = (await wake(ticket.assigneeAgentId, { ticketId: ticket.id, reason, priority: 3, note: text, causedByRunId })) as { status: string };
    return w.status === "steered" ? "sent to the running agent" : "the assignee will be woken with it";
  }

  async function templates(companyId: string): Promise<GitTemplates> {
    const [row] = await db.select().from(settings).where(eq(settings.key, `git_templates:${companyId}`));
    return { ...DEFAULT_GIT_TEMPLATES, ...((row?.value as Partial<GitTemplates> | undefined) ?? {}) };
  }

  return {
    setWakeHook(hook: NotifyHook) {
      wake = hook;
    },

    /** The ticket's changes against its base, from the runner that holds its worktree. */
    async diff(ticketId: string, companyId?: string, range: "base" | "last_turn" = "base"): Promise<WorkspaceDiff> {
      const { t, repoUrl } = await ticketWithRepo(ticketId, companyId);
      if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo, so there's no diff to review.");
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      if (!runner) throw new ReviewError(409, "The company has no runner.");
      try {
        return await deps.runners.request<WorkspaceDiff>(runner.id, (requestId) => ({ type: "workspace.diff", requestId, projectId: t.projectId, ticketId, ...(range === "last_turn" ? { range } : {}) }));
      } catch (err) {
        throw new ReviewError(409, (err as Error).message);
      }
    },

    /** One file of a ticket's work, from the runner that holds its repo (R77). */
    async readFile(ticketId: string, file: string, companyId?: string): Promise<{ text: string; truncated: boolean; from: "worktree" | "branch" }> {
      const { t, repoUrl } = await ticketWithRepo(ticketId, companyId);
      if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo.");
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      if (!runner) throw new ReviewError(409, "The company has no runner.");
      try {
        return await deps.runners.request(runner.id, (requestId) => ({ type: "workspace.file", requestId, projectId: t.projectId, ticketId, path: file }));
      } catch (err) {
        throw new ReviewError(409, (err as Error).message);
      }
    },

    /**
     * Records a review. Changes requested go to the agent as one message and move the ticket
     * back to in progress; approval finishes it.
     */
    async submit(
      ticketId: string,
      input: { verdict: "approved" | "changes_requested"; comments?: ReviewComment[]; summary?: string; reviewer: string; reviewerAgentId?: string | null; companyId?: string; causedByRunId?: string | null },
    ) {
      const { t } = await ticketWithRepo(ticketId, input.companyId);
      // The coder doesn't review its own work (R49).
      if (input.reviewerAgentId && t.assigneeAgentId === input.reviewerAgentId) throw new ReviewError(403, "You can't review a ticket assigned to you.");
      if (t.systemState === "done") throw new ReviewError(409, "That ticket is already done.");
      if (input.verdict === "approved") {
        await deps.loops.approved(ticketId, input.reviewer);
        // High and critical work is the owner's to approve (R48): an agent's approval asks them.
        if (input.reviewerAgentId && ownerReviews(t.risk)) {
          const [d] = await db
            .insert(decisions)
            .values({
              companyId: t.companyId,
              kind: "approval",
              question: `${input.reviewer} approved "${t.title}", which is rated ${riskOf(t.risk)} risk. Merge it, or send it back?`,
              options: ["Approve and merge", "Send it back"],
              recommendedOption: "Approve and merge",
              raisedByAgentId: input.reviewerAgentId,
              tier: "owner",
              dedupeKey: `risk-review:${ticketId}:${Date.now()}`,
              context: { type: "risk_review", ticketId, reviewer: input.reviewer },
            })
            .returning({ id: decisions.id });
          await db.insert(ticketDependencies).values({ blockedTicketId: ticketId, blockerDecisionId: d!.id });
          return { verdict: "approved" as const, outcome: "owner_review" as const, delivered: `the owner reviews ${riskOf(t.risk)}-risk work; decision ${d!.id}` };
        }
        return { verdict: "approved" as const, ...(await this.land(ticketId, input.reviewer, input.causedByRunId)) };
      }
      if (!input.comments?.length && !input.summary?.trim()) throw new ReviewError(422, "Say what needs changing: add comments or a summary.");
      let diffText = "";
      if (input.comments?.some((c) => !c.code)) diffText = await this.diff(ticketId).then((d) => d.diff, () => "");
      const text = formatReviewComments(input.reviewer, input.comments ?? [], diffText, input.summary);
      // A review that keeps coming back goes to the owner instead of another round (R49).
      const round = await deps.loops.reviewRound({ ticketId, reviewer: input.reviewer, comments: input.comments ?? [], message: text });
      if (round.escalated) return { verdict: "changes_requested" as const, delivered: `held for the owner (decision ${round.escalated})`, message: text, round: round.round };
      const delivered = await this.sendBack(ticketId, text, input.reviewer, input.causedByRunId);
      return { verdict: "changes_requested" as const, delivered, message: text, round: round.round };
    },

    /** Moves the ticket back to in progress and gives the agent the review. */
    async sendBack(ticketId: string, text: string, reviewer: string, causedByRunId?: string | null) {
      const { t } = await ticketWithRepo(ticketId);
      await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true });
      return tellAgent({ ...t, systemState: "in_progress" }, text, "review", causedByRunId);
    },

    /**
     * What approval does (R46, R47). Without a repo the ticket is simply done. With one, the
     * project's check runs in the worktree, then the branch is merged into the project's
     * default branch, and the merge closes the ticket. A failed check, a conflict or
     * uncommitted work sends the ticket back to the agent with what to do.
     */
    async land(ticketId: string, reviewer: string, causedByRunId?: string | null): Promise<{ outcome: "done" | "merged" | "pull_request" | "verify_failed" | "conflicts" | "uncommitted"; delivered: string | null; detail?: unknown }> {
      const { t, repoUrl, defaultBranch, verifyCommand, deepVerifyCommand, landing, gitHost, gitApiBase } = await ticketWithRepo(ticketId);
      if (!repoUrl) {
        await deps.work.updateTicket(ticketId, { state: "done", outcome: "completed", overLimit: true });
        return { outcome: "done", delivered: null };
      }
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      if (!runner) throw new ReviewError(409, "The company has no runner.");
      const ask = async <T>(build: (requestId: string) => Parameters<typeof deps.runners.send>[1], timeoutMs: number) => {
        try {
          return await deps.runners.request<T>(runner.id, build, timeoutMs);
        } catch (err) {
          throw new ReviewError(409, (err as Error).message);
        }
      };
      const sendBack = async (text: string, reason: string) => {
        await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true });
        return tellAgent({ ...t, systemState: "in_progress" }, text, reason, causedByRunId);
      };

      // The project's check, plus its deeper one for high and critical work (R47, R48).
      const checks = [verifyCommand, deepChecks(t.risk) ? deepVerifyCommand : null].filter((c): c is string => !!c);
      for (const command of checks) {
        const v = await ask<VerifyResult>((requestId) => ({ type: "workspace.verify", requestId, projectId: t.projectId, ticketId, command }), 11 * 60_000);
        if (!v.ok) {
          const why = v.timedOut ? "timed out" : `exited with code ${v.exitCode}`;
          // The same failing check again and again means the agent is going round in circles (R50).
          const loop = await deps.loops.failure({ companyId: t.companyId, ticketId, agentId: t.assigneeAgentId, text: v.timedOut ? `timeout: ${command}` : v.output, what: "The check" });
          const delivered = await sendBack(`The review was approved, but the check \`${command}\` ${why}, so the ticket can't be merged yet. Fix it, then move the ticket back to review.\n\nLast output:\n${v.output.slice(-4000)}${loop.circular ? DIFFERENT_APPROACH(loop.count) : ""}`, "verify failed");
          return { outcome: "verify_failed", delivered, detail: v };
        }
      }

      // A pull request: the host must be known and reachable before anything is pushed (R59).
      const pr = landing === "pull_request" ? await prTarget(t.companyId, repoUrl, gitHost, gitApiBase) : null;
      const m: MergeResult | PushResult = pr
        ? await ask<PushResult>((requestId) => ({ type: "workspace.push", requestId, projectId: t.projectId, ticketId, target: defaultBranch }), 2 * 60_000)
        : await ask<MergeResult>((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: `Merge "${t.title}" (${ticketId})` }), 2 * 60_000);
      if (m.status === "uncommitted") {
        const tpl = (await templates(t.companyId)).commit;
        const delivered = await sendBack(`The review was approved, but these files aren't committed: ${m.files.join(", ")}. ${renderTemplate(tpl, { branch: t.branch ?? `bossman/${t.id}`, base_ref: defaultBranch, ticket: t.title })} Then move the ticket back to review.`, "commit");
        return { outcome: "uncommitted", delivered, detail: m };
      }
      if (m.status === "conflicts") {
        const delivered = await sendBack(
          `The review was approved, but your branch conflicts with ${defaultBranch} in: ${m.files.join(", ")}. Merge origin/${defaultBranch} into your branch, resolve the conflicts keeping both sides' intent, run the checks${verifyCommand ? ` (\`${verifyCommand}\`)` : ""}, commit, then move the ticket back to review.`,
          "merge conflicts",
        );
        return { outcome: "conflicts", delivered, detail: m };
      }
      if (m.status === "pushed" && pr) {
        let opened;
        try {
          opened = await deps.gitHosts!.open(pr.cfg, pr.token, {
            head: m.branch,
            base: defaultBranch,
            title: t.title,
            body: `${t.body?.trim() ? `${t.body.trim()}\n\n` : ""}Opened by Boss Man for ticket ${t.id}, approved by ${reviewer}.`,
          });
        } catch (err) {
          throw new ReviewError(502, err instanceof GitHostError ? err.message : `Couldn't reach the git host: ${(err as Error).message}`);
        }
        await db.update(tickets).set({ pullRequestUrl: opened.url, pullRequestNumber: opened.number, pullRequestHead: m.commit, pullRequestNote: null }).where(eq(tickets.id, ticketId));
        return this.mergePullRequest(ticketId);
      }
      await db.update(tickets).set({ mergeCommit: m.commit }).where(eq(tickets.id, ticketId));
      await deps.work.updateTicket(ticketId, { state: "done", outcome: "completed", overLimit: true });
      return { outcome: "merged", delivered: null, detail: m };
    },

    /**
     * Merges the ticket's pull request if the host allows it now (R59). If not (approvals or
     * status checks still needed, or someone else must merge), the ticket waits in review with
     * the host's reason; the sync tries again, and finishes the ticket if it's merged on the host.
     */
    async mergePullRequest(ticketId: string): Promise<{ outcome: "merged" | "pull_request"; delivered: null; detail?: unknown }> {
      const { t, repoUrl, defaultBranch, gitHost, gitApiBase } = await ticketWithRepo(ticketId);
      if (!t.pullRequestNumber) throw new ReviewError(409, "This ticket has no pull request.");
      if (t.systemState === "done") return { outcome: "merged", delivered: null };
      const { cfg, token } = await prTarget(t.companyId, repoUrl, gitHost, gitApiBase);
      try {
        const now = await deps.gitHosts!.get(cfg, token, t.pullRequestNumber);
        if (now.merged) return finishMerged(t, now.mergeCommit);
        if (now.closed) return wait(t, "The pull request was closed on the host without merging. Reopen it there, or approve the ticket again to open a new one.");
        // Only the reviewed commit is merged: anything pushed to the branch since needs a new review.
        const tried = await deps.gitHosts!.merge(cfg, token, t.pullRequestNumber, { headSha: t.pullRequestHead, title: `Merge "${t.title}" into ${defaultBranch}`, message: `Boss Man ticket ${t.id}.` });
        return tried.merged ? finishMerged(t, tried.commit) : wait(t, tried.note);
      } catch (err) {
        if (err instanceof GitHostError) return wait(t, err.message);
        throw err;
      }
    },

    /**
     * Tells someone when a waiting pull request's checks change (R86): a failure goes to the
     * assignee, who is sent back to fix it; a pass goes to the CEO, who can see why it hasn't
     * merged. Each head commit and result is told once.
     */
    async notifyChecks(ticketId: string) {
      const { t, repoUrl, gitHost, gitApiBase } = await ticketWithRepo(ticketId);
      if (!t.pullRequestHead || !t.pullRequestNumber || t.systemState !== "review") return;
      const { cfg, token } = await prTarget(t.companyId, repoUrl, gitHost, gitApiBase);
      const c = await deps.gitHosts!.checks(cfg, token, t.pullRequestHead);
      const key = `${t.pullRequestHead}:${c.state}`;
      if ((c.state !== "failed" && c.state !== "passed") || key === t.pullRequestCi) return;
      await db.update(tickets).set({ pullRequestCi: key }).where(eq(tickets.id, ticketId));
      if (c.state === "failed" && t.assigneeAgentId) {
        await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true });
        await tellAgent({ ...t, systemState: "in_progress" }, `The checks on your pull request ${t.pullRequestUrl ?? ""} failed: ${c.failing.join(", ") || "see the host"}. Fix them, push, then move the ticket back to review.`, "ci failed");
      }
      if (c.state === "passed") {
        const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
        if (ceo) await wake?.(ceo.id, { ticketId, reason: "ci passed", note: `The checks passed on the pull request for "${t.title}", but it hasn't merged: ${t.pullRequestNote ?? "the host hasn't said why"}. Move it forward.` });
      }
    },

    /** Checks every ticket waiting on a pull request: merged on the host, or mergeable now. */
    async syncPullRequests() {
      const waiting = await db.select({ id: tickets.id }).from(tickets).where(and(isNotNull(tickets.pullRequestNumber), eq(tickets.systemState, "review")));
      let merged = 0;
      for (const w of waiting) {
        const r = await this.mergePullRequest(w.id).catch(() => null);
        if (r?.outcome === "merged") merged++;
        else if (r) await this.notifyChecks(w.id).catch(() => undefined);
      }
      return { checked: waiting.length, merged };
    },

    templates,

    async setTemplates(companyId: string, patch: Partial<GitTemplates>) {
      const next = { ...(await templates(companyId)), ...patch };
      await db.insert(settings).values({ key: `git_templates:${companyId}`, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } });
      return next;
    },

    /** Asks the agent to commit, or to push and open a PR, using the company's templates. */
    async gitAction(ticketId: string, action: "commit" | "pr") {
      const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
      if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo.");
      const tpl = (await templates(t.companyId))[action];
      const text = renderTemplate(tpl, { branch: t.branch ?? `bossman/${t.id}`, base_ref: defaultBranch, ticket: t.title });
      return { delivered: await tellAgent(t, text, action === "pr" ? "open pr" : "commit"), message: text };
    },
  };
}
