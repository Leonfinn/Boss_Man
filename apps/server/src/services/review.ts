// Review (R39): the review state carries the ticket's diff against its base, line comments
// go back to the agent as one message, and commit and PR steps are prompts from templates
// the owner can edit. Approving finishes the ticket until the merge step (R46) exists.
import { and, desc, eq, isNull } from "drizzle-orm";
import { DEFAULT_GIT_TEMPLATES, formatReviewComments, renderTemplate, type MergeResult, type ReviewComment, type VerifyResult, type WorkspaceDiff } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { projects, runners, runs, settings, tickets } from "../db/schema.js";
import type { runnersService } from "./runners.js";
import type { runsService } from "./runs.js";
import type { workService } from "./work.js";
import { DIFFERENT_APPROACH, type loopGuards } from "./loop-guards.js";

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type GitTemplates = { commit: string; pr: string };
type WakeHook = (input: { agentId: string; reason: string; note: string; ticketId?: string | null; priority?: number; causedByRunId?: string | null }) => Promise<unknown>;

export function reviewService(
  db: Db,
  deps: { runners: ReturnType<typeof runnersService>; runs: ReturnType<typeof runsService>; work: ReturnType<typeof workService>; loops: ReturnType<typeof loopGuards> },
) {
  let wake: WakeHook | null = null;

  async function ticketWithRepo(ticketId: string, companyId?: string) {
    const [row] = await db
      .select({ t: tickets, repoUrl: projects.repoUrl, defaultBranch: projects.defaultBranch, verifyCommand: projects.verifyCommand })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, ticketId));
    if (!row || (companyId && row.t.companyId !== companyId)) throw new ReviewError(404, "No such ticket.");
    return row;
  }

  /** Sends text to the ticket's live run if there is one, otherwise wakes its assignee with it. */
  async function tellAgent(ticket: typeof tickets.$inferSelect, text: string, reason: string, from: string, causedByRunId?: string | null) {
    const [live] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.ticketId, ticket.id), isNull(runs.endedAt)))
      .orderBy(desc(runs.startedAt));
    if (live) {
      await deps.runs.message(live.id, { text, from, companyId: ticket.companyId, causedByRunId });
      return "sent to the running agent";
    }
    if (!ticket.assigneeAgentId || !wake) throw new ReviewError(409, "The ticket has no assignee to send this to.");
    await wake({ agentId: ticket.assigneeAgentId, ticketId: ticket.id, reason, priority: 3, note: text, causedByRunId });
    return "the assignee will be woken with it";
  }

  async function templates(companyId: string): Promise<GitTemplates> {
    const [row] = await db.select().from(settings).where(eq(settings.key, `git_templates:${companyId}`));
    return { ...DEFAULT_GIT_TEMPLATES, ...((row?.value as Partial<GitTemplates> | undefined) ?? {}) };
  }

  return {
    setWakeHook(hook: WakeHook) {
      wake = hook;
    },

    /** The ticket's changes against its base, from the runner that holds its worktree. */
    async diff(ticketId: string, companyId?: string): Promise<WorkspaceDiff> {
      const { t, repoUrl } = await ticketWithRepo(ticketId, companyId);
      if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo, so there's no diff to review.");
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      if (!runner) throw new ReviewError(409, "The company has no runner.");
      try {
        return await deps.runners.request<WorkspaceDiff>(runner.id, (requestId) => ({ type: "workspace.diff", requestId, projectId: t.projectId, ticketId }));
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
      return tellAgent({ ...t, systemState: "in_progress" }, text, "review", reviewer, causedByRunId);
    },

    /**
     * What approval does (R46, R47). Without a repo the ticket is simply done. With one, the
     * project's check runs in the worktree, then the branch is merged into the project's
     * default branch, and the merge closes the ticket. A failed check, a conflict or
     * uncommitted work sends the ticket back to the agent with what to do.
     */
    async land(ticketId: string, reviewer: string, causedByRunId?: string | null): Promise<{ outcome: "done" | "merged" | "verify_failed" | "conflicts" | "uncommitted"; delivered: string | null; detail?: unknown }> {
      const { t, repoUrl, defaultBranch, verifyCommand } = await ticketWithRepo(ticketId);
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
        return tellAgent({ ...t, systemState: "in_progress" }, text, reason, reviewer, causedByRunId);
      };

      if (verifyCommand) {
        const v = await ask<VerifyResult>((requestId) => ({ type: "workspace.verify", requestId, projectId: t.projectId, ticketId, command: verifyCommand }), 11 * 60_000);
        if (!v.ok) {
          const why = v.timedOut ? "timed out" : `exited with code ${v.exitCode}`;
          // The same failing check again and again means the agent is going round in circles (R50).
          const loop = await deps.loops.failure({ companyId: t.companyId, ticketId, agentId: t.assigneeAgentId, text: v.timedOut ? `timeout: ${verifyCommand}` : v.output, what: "The check" });
          const delivered = await sendBack(`The review was approved, but the check \`${verifyCommand}\` ${why}, so the ticket can't be merged yet. Fix it, then move the ticket back to review.\n\nLast output:\n${v.output.slice(-4000)}${loop.circular ? DIFFERENT_APPROACH(loop.count) : ""}`, "verify failed");
          return { outcome: "verify_failed", delivered, detail: v };
        }
      }

      const m = await ask<MergeResult>(
        (requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: `Merge "${t.title}" (${ticketId})` }),
        2 * 60_000,
      );
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
      await db.update(tickets).set({ mergeCommit: m.commit }).where(eq(tickets.id, ticketId));
      await deps.work.updateTicket(ticketId, { state: "done", outcome: "completed", overLimit: true });
      return { outcome: "merged", delivered: null, detail: m };
    },

    templates,

    async setTemplates(companyId: string, patch: Partial<GitTemplates>) {
      const next = { ...(await templates(companyId)), ...patch };
      await db.insert(settings).values({ key: `git_templates:${companyId}`, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } });
      return next;
    },

    /** Asks the agent to commit, or to push and open a PR, using the company's templates. */
    async gitAction(ticketId: string, action: "commit" | "pr", from = "the owner") {
      const { t, repoUrl, defaultBranch } = await ticketWithRepo(ticketId);
      if (!repoUrl) throw new ReviewError(422, "That ticket's project has no git repo.");
      const tpl = (await templates(t.companyId))[action];
      const text = renderTemplate(tpl, { branch: t.branch ?? `bossman/${t.id}`, base_ref: defaultBranch, ticket: t.title });
      return { delivered: await tellAgent(t, text, action === "pr" ? "open pr" : "commit", from), message: text };
    },
  };
}
