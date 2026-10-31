// Review (R39): the review state carries the ticket's diff against its base, line comments
// go back to the agent as one message, and commit and PR steps are prompts from templates
// the owner can edit. Approving finishes the ticket until the merge step (R46) exists.
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { deepChecks, DEFAULT_GIT_TEMPLATES, formatReviewComments, MERGE_MISSED_AFTER_MS, parseRepoUrl, renderTemplate, riskOf, ruleFor, type GitHostKind, type MergeResult, type PushResult, type ReviewComment, type VerifyResult, type WorkspaceDiff, VERIFY_ASK_TIMEOUT_MS } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, checkResults, decisions, projects, reviewRequests, runners, settings, ticketDependencies, tickets } from "../db/schema.js";
import { addTicketDependency } from "./ticket-links.js";
import type { runnersService } from "./runners.js";
import type { workService } from "./work.js";
import { DIFFERENT_APPROACH, type loopGuards } from "./loop-guards.js";
import { GitHostError, type GitHostConfig, type gitHostService } from "./git-hosts.js";
import { effectivePolicy } from "./review-policy.js";
import { activeRows, decide, evaluate, latestRows, reviveSkipped, setReviewOrder, skipPending, wakeReviewers, type ReviewRow } from "./review-kinds.js";
import { CHECK_AGAIN, CHECK_SEND_BACK, CHECK_SKIP, clearMergeCards, raiseMergeStuck } from "./decisions.js";
import { LESSON_ADD, LESSON_DROP, LESSON_EDIT, LESSON_MAX, lessonsForCeo, normalizeLesson } from "./project-brief.js";
import { record } from "./activity.js";
import type { notificationsService } from "./notifications.js";

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the owner sees while and after an approval lands (B): in plain words. */
export type LandingStatus = { state: "running"; startedAt: string; command: string | null; startedBy: string } | { state: "finished"; outcome: string; text: string; url: string | null; finishedAt: string };
/**
 * A running landing as the page sees it. `stale` means the ticket has gone quiet for longer than a
 * merge can take (the same heartbeat the unmerged-approvals sweep watches), so the marker is a
 * leftover and the owner may start it again rather than waiting forever.
 */
export type LandingView = (LandingStatus & { stale?: boolean }) | null;

/**
 * A check that was killed or timed out says nothing about the agent's work (the runner ran out of
 * memory, say), so it goes to the owner instead of back to the agent. Why it ended, or null if it
 * simply failed.
 */
export function checkNeverFinished(v: { timedOut: boolean; exitCode: number | null; output: string }): "timed_out" | "out_of_memory" | "killed" | null {
  const tail = v.output.slice(-4000);
  if (v.timedOut) return "timed_out";
  if (/JavaScript heap out of memory|out of memory|ENOMEM|Cannot allocate memory/i.test(tail)) return "out_of_memory";
  if (v.exitCode === 137 || v.exitCode === 143 || v.exitCode === null || /\bSIGKILL\b|\bKilled\b|Worker exited unexpectedly/i.test(tail)) return "killed";
  return null;
}

/**
 * True when the check gave up only because it waited too long for the shared heavy-phase lock:
 * scripts/check-all.sh exits 75 with this wording before any step runs, so nothing the agent wrote failed.
 */
export function checkWaitedForLock(v: { exitCode: number | null; output: string }): boolean {
  return v.exitCode === 75 && /check-all: gave up waiting for the heavy-phase lock/.test(v.output);
}
/** Tries a merge check that only timed out on the lock this many times, pausing LOCK_RETRY_BASE_MS, then double, between them. */
export const LOCK_RETRY_ATTEMPTS = 6;
export let LOCK_RETRY_BASE_MS = 60_000;
/** For tests. */
export const setLockRetryBase = (ms: number) => { LOCK_RETRY_BASE_MS = ms; };
export const LOCK_RETRY_TEXT = "Merge check waiting for lock, retrying";

/** How long the server waits for the runner to merge or push an approved branch. */
export const MERGE_WAIT_MS = 10 * 60_000;
/** How often a landing in progress says it is still active, so a sweep never starts a second one beside it. */
export const MERGE_ACTIVITY_MS = 60_000;

/** What the author hears when a ticket that needs code changes has none. */
export const NOTHING_CHANGED = "Nothing in the repository changed. Make the change, or ask your CEO or a manager to mark the ticket as not needing code (update_ticket with noCode true) and say why.";

/** The plain-words outcome of landing, for a non-developer. */
export function landingText(r: { outcome: string; detail?: unknown }, ctx: { branch: string; assignee: string | null }): string {
  const d = (r.detail ?? {}) as { timedOut?: boolean; exitCode?: number; ms?: number; files?: string[]; url?: string | null; note?: string };
  const back = `It's gone back to ${ctx.assignee ?? "the assignee"}`;
  switch (r.outcome) {
    case "merged":
      return `Merged into ${ctx.branch}.`;
    case "done":
      return `Approved; the ticket is done.${d.note ? ` ${d.note}` : ""}`;
    case "pull_request":
      return `${d.url ? `Pull request opened: ${d.url}.` : "Approved."}${d.note ? ` It hasn't merged yet: ${d.note}` : ""}`;
    case "empty":
      return `Approved, but not closed: nothing in the repository changed. ${back} to make the change, or to mark the ticket as not needing code.`;
    case "verify_failed":
      return `Approved, but not merged: the check ${d.timedOut ? `timed out after ${Math.max(1, Math.round((d.ms ?? 0) / 60_000))} minutes` : `failed (exit code ${d.exitCode})`}. ${back} to fix; the check's output is in the conversation below.`;
    case "check_stuck":
      return "Approved, but not merged: the check couldn't finish. This isn't a problem with the agent's work; it's in your Decisions.";
    case "conflicts":
      return `Approved, but not merged: the work conflicts with ${ctx.branch} in ${(d.files ?? []).join(", ")}. ${back} to sort out.`;
    case "uncommitted":
      return `Approved, but not merged: some work isn't saved to the branch yet (${(d.files ?? []).join(", ")}). ${back} to commit it.`;
    default:
      return `Approved, but not merged (${r.outcome.replace(/_/g, " ")}).`;
  }
}

/** Narrow on purpose: only the owner's "Merge without the check" uses skipChecks, for one landing. */
export type LandOptions = { skipChecks?: boolean };

export type GitTemplates = { commit: string; pr: string };
type NotifyHook = (agentId: string, input: { reason: string; note: string; ticketId?: string | null; priority?: number; causedByRunId?: string | null }) => Promise<unknown>;

/** The owner decides what to do with a check that couldn't finish; the ticket stays in review and the loop detector never hears of it. */
async function raiseCheckStuck(db: Db, t: { companyId: string; id: string; title: string }, command: string, reason: string, output: string) {
  // A ticket closed while its check was running needs no merge card (BOS-149): read the state
  // again, because the ticket may have been merged or cancelled since this landing began.
  const [latest] = await db.select({ systemState: tickets.systemState }).from(tickets).where(eq(tickets.id, t.id));
  if (!latest || latest.systemState === "done") return;
  // One open merge card per ticket: this one replaces any older card (BOS-149).
  await clearMergeCards(db, t.id, { by: "system", note: `Replaced by a newer merge card: the check \`${command}\` ${reason}.`, at: new Date().toISOString() });
  await db
    .insert(decisions)
    .values({
      companyId: t.companyId,
      kind: "question",
      question: `"${t.title}": the merge check \`${command}\` couldn't finish (it ${reason}). This isn't a problem with the agent's work.`,
      options: [CHECK_AGAIN, CHECK_SEND_BACK, CHECK_SKIP],
      recommendedOption: CHECK_AGAIN,
      tier: "owner",
      dedupeKey: `merge-stuck:${t.id}`,
      context: { type: "check_stuck", ticketId: t.id, command, output: output.slice(-1500) },
    })
    .onConflictDoNothing();
}

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
    /** False on a standby copy (blue/green): a merge cut off by the hand-over is left to the leader's sweep. */
    isLeader?: () => boolean;
  },
) {
  let wake: NotifyHook | null = null;
  // shortcut: in memory, so a server restart mid-landing forgets the status (the ticket itself is unaffected); upgrade to a column if owners need it to survive restarts.
  const landings = new Map<string, LandingStatus>();

  async function ticketWithRepo(ticketId: string, companyId?: string) {
    const [row] = await db
      .select({
        t: tickets,
        repoUrl: projects.repoUrl,
        projectName: projects.name,
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

  /**
   * True when a running landing's ticket has gone quiet for longer than a merge can take. The ticket's
   * last activity is the heartbeat every landing keeps, so this uses the same sign of life as the sweep.
   */
  async function landingStale(ticketId: string): Promise<boolean> {
    const [row] = await db.select({ state: tickets.systemState, lastActivityAt: tickets.lastActivityAt }).from(tickets).where(eq(tickets.id, ticketId));
    if (!row || row.state !== "review") return true;
    return Date.now() - row.lastActivityAt.getTime() > MERGE_MISSED_AFTER_MS;
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

    /**
     * True when a ticket that needs code changes has none yet: its project has a repo, it isn't
     * marked "no code", and the runner reports no commits and no changed files. If the runner
     * can't answer, this is false, so an offline runner never blocks a move to review. A ticket
     * with no branch was never worked on, so it has nothing, whatever the runner says.
     */
    async needsChanges(ticketId: string, companyId?: string): Promise<boolean> {
      const { t, repoUrl } = await ticketWithRepo(ticketId, companyId);
      if (!repoUrl || t.noCode) return false;
      if (!t.branch) return true;
      const d = await this.diff(ticketId, companyId).catch(() => null);
      return !!d && !d.commits.length && !d.files.length;
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
     * Records a review. Where the ticket has required reviews (see review-kinds.ts) an agent's verdict
     * fills its own; the ticket moves only when they are all in. Changes requested go to the agent
     * as one message and move the ticket back to in progress; approval finishes it.
     */
    async submit(
      ticketId: string,
      input: { verdict: "approved" | "changes_requested"; comments?: ReviewComment[]; summary?: string; /** Optional one-line lesson learned, when sending it back (R-review-lessons); the owner decides. */ lesson?: string; reviewer: string; reviewerAgentId?: string | null; /** Which of the agent's reviews, when it holds several. */ kind?: string; companyId?: string; causedByRunId?: string | null; /** Land in the background and return at once (the owner's page polls `landing`). */ background?: boolean },
    ) {
      const { t, projectName } = await ticketWithRepo(ticketId, input.companyId);
      // The coder doesn't review its own work (R49).
      if (input.reviewerAgentId && t.assigneeAgentId === input.reviewerAgentId) throw new ReviewError(403, "You can't review a ticket assigned to you.");
      if (t.systemState === "done") throw new ReviewError(409, "That ticket is already done.");
      if (input.lesson?.trim() && input.verdict !== "changes_requested") throw new ReviewError(422, "A lesson goes with changes requested, not with an approval.");
      if ((input.lesson?.trim().length ?? 0) > LESSON_MAX) throw new ReviewError(422, "A lesson is one line, up to 240 characters.");
      const lesson = normalizeLesson(input.lesson ?? "");
      if (input.lesson?.trim() && !lesson) throw new ReviewError(422, "A lesson is one line, up to 240 characters.");
      const rows = input.reviewerAgentId ? await latestRows(db, ticketId) : [];
      if (input.verdict === "changes_requested" && !input.comments?.length && !input.summary?.trim()) throw new ReviewError(422, "Say what needs changing: add comments or a summary.");
      // Each lesson becomes exactly one CEO decision (BOS-105): nothing reaches the brief without it, and the owner is told the outcome.
      if (lesson) {
        const question = `Add this lesson to ${projectName}'s brief? "${lesson}"\n\nIt came from the review of ticket "${t.title}" (${ticketId}).\n\n${await lessonsForCeo(db, t.companyId, t.projectId)}\n\nJudge whether it overlaps a lesson already there and whether it is worth a line. Answer with a one-line reason as the note.`;
        const [row] = await db
          .insert(decisions)
          .values({
            companyId: t.companyId,
            kind: "question",
            question,
            options: [LESSON_ADD, LESSON_EDIT, LESSON_DROP],
            recommendedOption: LESSON_ADD,
            tier: "ceo",
            raisedByAgentId: input.reviewerAgentId ?? null,
            dedupeKey: `lesson:${ticketId}:${lesson}`,
            context: { type: "lesson", ticketId, projectId: t.projectId, projectName, lesson },
          })
          .onConflictDoNothing()
          .returning({ id: decisions.id });
        if (row) {
          const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
          if (ceo) await wake?.(ceo.id, { reason: "decision", note: `A decision is waiting for you: ${question}\nUse the decisions tool to read it and answer.` });
        }
      }
      let diffText = "";
      if (input.verdict === "changes_requested" && input.comments?.some((c) => !c.code)) diffText = await this.diff(ticketId).then((d) => d.diff, () => "");
      if (!rows.length) {
        if (input.verdict === "approved") return this.approve(t, { reviewer: input.reviewer, reviewerAgentId: input.reviewerAgentId, background: input.background, causedByRunId: input.causedByRunId });
        // The owner sending it back ends any reviews still open.
        if (!input.reviewerAgentId) await skipPending(db, await latestRows(db, ticketId));
        return this.sendBackRound(t, { reviewer: input.reviewer, comments: input.comments ?? [], text: formatReviewComments(input.reviewer, input.comments ?? [], diffText, input.summary), causedByRunId: input.causedByRunId });
      }

      // An agent's verdict fills one of the ticket's required reviews.
      const mine = rows.filter((r) => r.reviewerAgentId === input.reviewerAgentId && r.status === "pending" && (!input.kind || r.kind === input.kind));
      // Every review is already in (approved or overruled) but the merge never ran: nothing is left to fill, so say so,
      // and let an approval from a reviewer who held a slot start the merge instead of refusing it ("no open review").
      if (!mine.length && t.systemState === "review" && evaluate(rows) === "passed" && rows.some((r) => r.reviewerAgentId === input.reviewerAgentId)) {
        if (input.verdict !== "approved") throw new ReviewError(409, "Every review on this ticket is already in and approved; it is waiting to merge. Ask the CEO if it should go back to the agent.");
        const [signoff] = await db
          .select({ id: decisions.id })
          .from(ticketDependencies)
          .innerJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
          .where(and(eq(ticketDependencies.blockedTicketId, ticketId), eq(decisions.status, "open")));
        if (signoff) throw new ReviewError(409, "Every review is in; the ticket is waiting on the owner's decision before it merges.");
        if (landings.get(ticketId)?.state === "running" && !(await landingStale(ticketId))) throw new ReviewError(409, "Every review is in and the merge is running now.");
        await record(db, { companyId: t.companyId, agentId: input.reviewerAgentId ?? null, ticketId, kind: "merge_restarted", summary: `All reviews were in but the merge had not run; ${input.reviewer} confirmed the approval, so Boss Man started it.` });
        return this.approve(t, { reviewer: input.reviewer, reviewerAgentId: input.reviewerAgentId, background: input.background, causedByRunId: input.causedByRunId });
      }
      if (!mine.length) throw new ReviewError(rows.some((r) => r.reviewerAgentId === input.reviewerAgentId) ? 409 : 403, "You have no open review on this ticket. The CEO can overrule a review that asked for changes.");
      const active = activeRows(rows);
      const ready = mine.filter((r) => active.some((a) => a.id === r.id));
      if (!ready.length) throw new ReviewError(409, `Not yet: your ${mine[0]!.kind} review waits for an earlier review to finish first. You'll be woken when it's your turn.`);
      if (ready.length > 1) throw new ReviewError(422, `You hold more than one review here (${ready.map((r) => r.kind).join(", ")}); say which with kind.`);
      const row = ready[0]!;
      const who = row.kind === "code" ? input.reviewer : `${input.reviewer}, ${row.kind} review`;
      if (input.verdict === "approved") {
        await decide(db, row.id, { status: "approved", notes: input.summary?.trim() || null });
      } else {
        await decide(db, row.id, { status: "changes_requested", notes: formatReviewComments(who, input.comments ?? [], diffText, input.summary), comments: input.comments ?? [] });
      }
      return this.settle(t, { verdict: input.verdict, reviewer: input.reviewer, reviewerAgentId: input.reviewerAgentId!, background: input.background, causedByRunId: input.causedByRunId, before: active });
    },

    /** After a verdict, an overrule or a new order: wake who is next, send the work back, or approve it. */
    async settle(t: typeof tickets.$inferSelect, o: { verdict: "approved" | "changes_requested"; reviewer: string; reviewerAgentId: string; background?: boolean; causedByRunId?: string | null; before: ReviewRow[] }) {
      const rows = await latestRows(db, t.id);
      const state = evaluate(rows);
      if (state === "waiting") {
        const was = new Set(o.before.map((r) => r.id));
        if (wake) await wakeReviewers(db, t, activeRows(rows).filter((r) => !was.has(r.id)), (id, i) => wake!(id, i), [], o.causedByRunId);
        return { verdict: o.verdict, outcome: "waiting" as const, delivered: `recorded; waiting for the other reviews (${activeRows(rows).map((r) => r.kind).join(", ")})` };
      }
      if (state === "passed") {
        const names = [...new Set(rows.filter((r) => r.status === "approved").map((r) => r.reviewerAgentId))];
        const label = names.length > 1 ? (await db.select({ name: agents.name }).from(agents).where(inArray(agents.id, names.filter((n): n is string => !!n)))).map((a) => a.name).join(" and ") : o.reviewer;
        return await this.approve(t, { reviewer: label, reviewerAgentId: o.reviewerAgentId, background: o.background, causedByRunId: o.causedByRunId });
      }
      await skipPending(db, rows);
      const failed = rows.filter((r) => r.status === "changes_requested");
      const text = failed.map((r) => r.notes).join("\n\n");
      const sent = await this.sendBackRound(t, { reviewer: failed.map((r) => (r.kind === "code" ? "the reviewer" : `the ${r.kind} reviewer`)).join(" and "), comments: failed.flatMap((r) => r.comments as ReviewComment[]), text, causedByRunId: o.causedByRunId });
      return sent;
    },

    /** Approval is final unless the owner signs off (R48); then it asks them. The CEO cannot stand in for that. */
    async approve(t: typeof tickets.$inferSelect, o: { reviewer: string; reviewerAgentId?: string | null; background?: boolean; causedByRunId?: string | null }) {
      const ticketId = t.id;
      await deps.loops.approved(ticketId, o.reviewer);
      // Where the review policy says the owner signs off, an agent's approval asks them (R48).
      if (o.reviewerAgentId && ruleFor(await effectivePolicy(db, t), t.risk).ownerSignoff) {
        const [d] = await db
          .insert(decisions)
          .values({
            companyId: t.companyId,
            kind: "approval",
            question: `${o.reviewer} approved "${t.title}", which is rated ${riskOf(t.risk)} risk. Merge it, or send it back?`,
            options: ["Approve and merge", "Send it back"],
            recommendedOption: "Approve and merge",
            raisedByAgentId: o.reviewerAgentId,
            tier: "owner",
            dedupeKey: `risk-review:${ticketId}:${Date.now()}`,
            context: { type: "risk_review", ticketId, reviewer: o.reviewer },
          })
          .returning({ id: decisions.id });
        await addTicketDependency(db, { companyId: t.companyId, blockedTicketId: ticketId, blockerDecisionId: d!.id, actor: { type: "system" } });
        return { verdict: "approved" as const, outcome: "owner_review" as const, delivered: `the owner reviews ${riskOf(t.risk)}-risk work; decision ${d!.id}` };
      }
      if (o.background) return { verdict: "approved" as const, outcome: "landing" as const, delivered: null, landing: await this.startLanding(ticketId, o.reviewer, o.causedByRunId) };
      return { verdict: "approved" as const, ...(await this.landVisible(ticketId, o.reviewer, o.causedByRunId)) };
    },

    /** Changes requested: a review that keeps coming back goes to the owner instead of another round (R49). */
    async sendBackRound(t: typeof tickets.$inferSelect, o: { reviewer: string; comments: ReviewComment[]; text: string; causedByRunId?: string | null }) {
      const round = await deps.loops.reviewRound({ ticketId: t.id, reviewer: o.reviewer, comments: o.comments, message: o.text });
      if (round.escalated) return { verdict: "changes_requested" as const, outcome: "escalated" as const, delivered: `held: the review looks stuck, so the CEO (or the owner, if the CEO can't settle it) decides what happens next (decision ${round.escalated})`, message: o.text, round: round.round };
      const delivered = await this.sendBack(t.id, o.text, o.reviewer, o.causedByRunId);
      return { verdict: "changes_requested" as const, outcome: "sent_back" as const, delivered, message: o.text, round: round.round };
    },

    /** The CEO sets the order of a ticket's reviews, for when one depends on another. */
    async sequence(ticketId: string, order: string[], byAgentId: string, companyId: string) {
      const { t } = await ticketWithRepo(ticketId, companyId);
      const woken = await setReviewOrder(db, t, order, byAgentId);
      if (wake) await wakeReviewers(db, t, woken, (id, i) => wake!(id, i));
      return woken.length;
    },

    /** The CEO overrules a "changes requested", with a reason kept on the ticket. Owner sign-off still applies. */
    async overrule(ticketId: string, input: { kind: string; reason: string; byAgentId: string; companyId: string; causedByRunId?: string | null; background?: boolean }) {
      const { t } = await ticketWithRepo(ticketId, input.companyId);
      if (t.systemState === "done") throw new ReviewError(409, "That ticket is already done.");
      if (t.systemState === "blocked") throw new ReviewError(409, "That ticket is waiting on a decision from the owner.");
      const rows = await latestRows(db, ticketId);
      const row = rows.find((r) => r.kind === input.kind && r.status === "changes_requested");
      if (!row) throw new ReviewError(409, `There's no ${input.kind} review asking for changes on that ticket.`);
      if (!input.reason.trim()) throw new ReviewError(422, "Give the reason you're overruling it.");
      const before = activeRows(rows);
      await decide(db, row.id, { status: "overruled", overruledByAgentId: input.byAgentId, overruleReason: input.reason.trim() });
      await record(db, { companyId: t.companyId, agentId: input.byAgentId, ticketId, kind: "review_overruled", summary: `The CEO overruled the ${input.kind} review's changes requested: ${input.reason.trim()}` });
      await reviveSkipped(db, rows);
      const after = await latestRows(db, ticketId);
      // Reviews that never ran now have to: the ticket goes back into review for them.
      if (evaluate(after) === "waiting" && t.systemState !== "review") await deps.work.updateTicket(ticketId, { state: "review", overLimit: true });
      return this.settle(t, { verdict: "approved", reviewer: "the CEO", reviewerAgentId: input.byAgentId, background: input.background, causedByRunId: input.causedByRunId, before });
    },

    /**
     * The landing the page should show. A running marker whose ticket has gone quiet for longer
     * than a merge can take is a leftover: it is marked stale so the owner can try again.
     */
    async landing(ticketId: string): Promise<LandingView> {
      const status = landings.get(ticketId);
      if (!status) return null;
      if (status.state === "finished") return status;
      return { ...status, stale: await landingStale(ticketId) };
    },

    /** Claims the ticket's merge marker, so the page shows the merge from its first moment. */
    async claimLanding(ticketId: string, reviewer: string): Promise<string> {
      const existing = landings.get(ticketId);
      if (existing?.state === "running") {
        if (!(await landingStale(ticketId))) throw new ReviewError(409, "This ticket is already being checked and merged.");
        // Only replace the marker we judged stale: another approval may have claimed it while we checked the heartbeat.
        if (landings.get(ticketId) !== existing) throw new ReviewError(409, "This ticket is already being checked and merged.");
        landings.delete(ticketId);
      }
      // Claimed before the first await, so two approvals at the same moment cannot both start a landing.
      const startedAt = new Date().toISOString();
      landings.set(ticketId, { state: "running", startedAt, command: null, startedBy: reviewer });
      // A ticket can sit in review for hours before its last reviewer approves. Count the merge itself as
      // activity now, so the very first poll of a fresh merge is never judged stale from that quiet spell.
      await db.update(tickets).set({ lastActivityAt: new Date() }).where(eq(tickets.id, ticketId));
      return startedAt;
    },

    /**
     * Lands and waits, as land() does (a sign-off card's answer still finishes the merge before it returns),
     * but keeps the running marker for as long as it takes so every page shows the merge in flight.
     */
    async landVisible(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions) {
      await this.claimLanding(ticketId, reviewer);
      try {
        return await this.land(ticketId, reviewer, causedByRunId, opts);
      } finally {
        // The ticket page reloads when a running marker goes away; a finished banner comes from startLanding.
        if (landings.get(ticketId)?.state === "running") landings.delete(ticketId);
      }
    },

    /** Runs land() without holding the request (the check can take minutes); the outcome is kept for the page to poll. */
    async startLanding(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<LandingStatus> {
      const startedAt = await this.claimLanding(ticketId, reviewer);
      let ctx: Awaited<ReturnType<typeof ticketWithRepo>>;
      try {
        ctx = await ticketWithRepo(ticketId);
      } catch (err) {
        landings.delete(ticketId);
        // The approval is already recorded: leave a trail and a card, as land() does, so the ticket is not silently stuck.
        const message = err instanceof Error ? err.message : String(err);
        const [row] = await db.select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ticketId));
        if (row) {
          await record(db, { companyId: row.companyId, ticketId, kind: "merge_failed", summary: `Approved, but the merge couldn't start: ${message}` });
          await raiseMergeStuck(db, row, message);
        }
        throw err;
      }
      const { t, defaultBranch, verifyCommand, deepVerifyCommand, repoUrl } = ctx;
      const command = repoUrl ? ([verifyCommand, deepChecks(t.risk) ? deepVerifyCommand : null].filter(Boolean) as string[]).join(" && ") || null : null;
      const running: LandingStatus = { state: "running", startedAt, command, startedBy: reviewer };
      landings.set(ticketId, running);
      void (async () => {
        let text: string;
        let outcome = "failed";
        let url: string | null = null;
        try {
          const r = await this.land(ticketId, reviewer, causedByRunId, opts);
          const [a] = t.assigneeAgentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, t.assigneeAgentId)) : [];
          outcome = r.outcome;
          url = (r.detail as { url?: string | null } | undefined)?.url ?? null;
          text = landingText(r, { branch: defaultBranch, assignee: a?.name ?? null });
        } catch (err) {
          text = `Approved, but not merged: ${(err as Error).message}`;
        }
        landings.set(ticketId, { state: "finished", outcome, text, url, finishedAt: new Date().toISOString() });
      })();
      return running;
    },

    /** Moves the ticket back to in progress and gives the agent the review. */
    async sendBack(ticketId: string, text: string, reviewer: string, causedByRunId?: string | null) {
      const { t } = await ticketWithRepo(ticketId);
      await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
      return tellAgent({ ...t, systemState: "in_progress" }, text, "review", causedByRunId);
    },

    /**
     * What approval does (R46, R47). Without a repo the ticket is simply done. With one, the
     * project's check runs in the worktree, then the branch is merged into the project's
     * default branch, and the merge closes the ticket. A failed check, a conflict or
     * uncommitted work sends the ticket back to the agent with what to do.
     */
    async land(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<{ outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted"; delivered: string | null; detail?: unknown }> {
      try {
        // A merge check that only waited too long for the shared lock is queued again, with a longer pause each time.
        // The ticket stays in review; the pause counts as activity so the unmerged-approvals sweep leaves it alone.
        for (let attempt = 1; ; attempt++) {
          const r = await this.landOnce(ticketId, reviewer, causedByRunId, opts);
          if (r.outcome !== "lock_wait") return r;
          const { t } = await ticketWithRepo(ticketId);
          const d = r.detail as { command: string; output: string };
          if (attempt >= LOCK_RETRY_ATTEMPTS) {
            await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `Merge check gave up waiting for the lock after ${attempt} tries; it's in your Decisions.` });
            await raiseCheckStuck(db, t, d.command, "kept waiting for the shared lock, which other checks held", d.output);
            return { outcome: "check_stuck", delivered: null, detail: r.detail };
          }
          const pause = LOCK_RETRY_BASE_MS * 2 ** (attempt - 1);
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_check_lock_wait", summary: `${LOCK_RETRY_TEXT} (try ${attempt} of ${LOCK_RETRY_ATTEMPTS}, next in ${Math.max(1, Math.round(pause / 60_000))} min). Nothing failed; no need to run it by hand.` });
          const beat = setInterval(() => void db.update(tickets).set({ lastActivityAt: new Date() }).where(eq(tickets.id, ticketId)).catch(() => undefined), MERGE_ACTIVITY_MS);
          beat.unref?.();
          try {
            await new Promise((resolve) => setTimeout(resolve, pause));
          } finally {
            clearInterval(beat);
          }
          // Approval can be withdrawn while we wait: don't merge something no longer in review.
          const [now] = await db.select({ state: tickets.systemState }).from(tickets).where(eq(tickets.id, ticketId));
          if (now?.state !== "review") return { outcome: "check_stuck", delivered: null, detail: { note: "The ticket left review while the merge check waited, so it was not retried." } };
        }
      } catch (caught) {
        const err = caught instanceof Error ? caught : new Error(String(caught));
        // Any failure counts, not only ReviewError: a database or git exception would otherwise leave an approved ticket with no record and no card.
        // The approval is already recorded, so nothing else would move the ticket: say so on it and ask the owner as well.
        const [t] = await db.select({ id: tickets.id, title: tickets.title, companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ticketId));
        if (!t) throw err;
        // Handed over mid-merge (a deploy swapped the server copies): the copy now in charge tries again by itself.
        if (deps.isLeader && !deps.isLeader()) {
          await record(db, { companyId: t.companyId, ticketId, kind: "merge_failed", summary: `The merge was cut off when the server handed over (${err.message}); the server now in charge will try again.` });
          throw err;
        }
        await record(db, { companyId: t.companyId, ticketId, kind: "merge_failed", summary: `Approved, but the merge couldn't run: ${err.message}` });
        await raiseMergeStuck(db, t, err.message);
        // Whoever approved still hears why, as before.
        throw err;
      }
    },

    async landOnce(ticketId: string, reviewer: string, causedByRunId?: string | null, opts?: LandOptions): Promise<{ outcome: "done" | "merged" | "pull_request" | "empty" | "verify_failed" | "check_stuck" | "lock_wait" | "conflicts" | "uncommitted"; delivered: string | null; detail?: unknown }> {
      const { t, repoUrl, defaultBranch, verifyCommand, deepVerifyCommand, landing, gitHost, gitApiBase } = await ticketWithRepo(ticketId);
      // An answer to an older "merge stuck" ask can arrive after the ticket merged: nothing to do again.
      if (t.systemState === "done") return { outcome: "done", delivered: null, detail: { note: "It was already finished, so nothing ran again." } };
      // A retry must not merge past the owner's sign-off (BOS-149): if a "Merge it, or send it back?"
      // card is still open, this ticket waits for the owner, whatever answered the merge card.
      const [signoff] = await db
        .select({ id: decisions.id })
        .from(decisions)
        .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'risk_review'`, sql`${decisions.context}->>'ticketId' = ${ticketId}`))
        .limit(1);
      if (signoff) throw new ReviewError(409, "The owner's sign-off for this ticket is still waiting, so nothing was merged. Answer that card first.");
      // A merge under way is activity: the unmerged-approvals sweep waits for it rather than asking again.
      const touch = () => db.update(tickets).set({ lastActivityAt: new Date() }).where(eq(tickets.id, ticketId));
      await touch();
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
        await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
        return tellAgent({ ...t, systemState: "in_progress" }, text, reason, causedByRunId);
      };
      // Checks can run for half an hour and merges can queue behind other work: keep saying the ticket
      // is active while we wait, so the unmerged-approvals sweep never starts a second landing beside it.
      const whileActive = async <T>(work: () => Promise<T>): Promise<T> => {
        const beat = setInterval(() => void touch().catch(() => undefined), MERGE_ACTIVITY_MS);
        beat.unref?.();
        try {
          return await work();
        } finally {
          clearInterval(beat);
        }
      };

      // Nothing changed in the repository (a wiki-only ticket, say): there is nothing to check or
      // merge, and running the check anyway could send the ticket back for a failure it can't fix.
      const changed = await whileActive(() => ask<WorkspaceDiff>((requestId) => ({ type: "workspace.diff", requestId, projectId: t.projectId, ticketId }), 60_000)).catch(() => null);
      if ((changed && !changed.commits.length && !changed.files.length) || (!changed && !t.branch)) {
        // Only a ticket marked "no code" closes on an empty diff; any other is sent back, not closed.
        if (!t.noCode) {
          const delivered = await sendBack(`The review was approved, but the ticket can't be closed: ${NOTHING_CHANGED} Then move the ticket back to review.`, "nothing changed");
          return { outcome: "empty", delivered };
        }
        await deps.work.updateTicket(ticketId, { state: "done", outcome: "completed", overLimit: true });
        return { outcome: "done", delivered: null, detail: { note: "Nothing in the repository changed, so there was nothing to check or merge." } };
      }

      // The project's check, plus its deeper one for high and critical work (R47, R48).
      const checks = opts?.skipChecks ? [] : [verifyCommand, deepChecks(t.risk) ? deepVerifyCommand : null].filter((c): c is string => !!c);
      for (const command of checks) {
        await touch();
        const v = await whileActive(() => ask<VerifyResult>((requestId) => ({ type: "workspace.verify", requestId, projectId: t.projectId, ticketId, command }), VERIFY_ASK_TIMEOUT_MS));
        await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: t.pullRequestHead, kind: command === deepVerifyCommand && command !== verifyCommand ? "deep_verify" : "verify", passed: v.ok, detail: v.ok ? null : v.output.slice(-500) });
        if (!v.ok) {
          // Only the wait for the shared lock ran out: no step ran, so nothing is wrong with the work. land() tries again.
          if (checkWaitedForLock(v)) return { outcome: "lock_wait", delivered: null, detail: { ...v, command } };
          const never = checkNeverFinished(v);
          if (never) {
            const reason = never === "timed_out" ? `timed out after ${Math.max(1, Math.round(v.ms / 60_000))} min` : never === "out_of_memory" ? "ran out of memory" : "was killed";
            await raiseCheckStuck(db, t, command, reason, v.output);
            return { outcome: "check_stuck", delivered: null, detail: v };
          }
          const why = v.timedOut ? "timed out" : `exited with code ${v.exitCode}`;
          // The same failing check again and again means the agent is going round in circles (R50).
          const loop = await deps.loops.failure({ companyId: t.companyId, ticketId, agentId: t.assigneeAgentId, text: v.timedOut ? `timeout: ${command}` : v.output, what: "The check" });
          const delivered = await sendBack(`The review was approved, but the check \`${command}\` ${why}, so the ticket can't be merged yet. Fix it, then move the ticket back to review.\n\nLast output:\n${v.output.slice(-4000)}${loop.circular ? DIFFERENT_APPROACH(loop.count) : ""}`, "verify failed");
          return { outcome: "verify_failed", delivered, detail: v };
        }
      }

      // A pull request: the host must be known and reachable before anything is pushed (R59).
      const pr = landing === "pull_request" ? await prTarget(t.companyId, repoUrl, gitHost, gitApiBase) : null;
      // The runner does one git job per repo at a time, so a merge can queue behind other agents' fetches and
      // worktree set-ups before its own fetch and push; two minutes wasn't enough on a busy project. A merge
      // that finishes after this is still safe: trying again finds the branch already merged.
      await touch();
      const m: MergeResult | PushResult = pr
        ? await whileActive(() => ask<PushResult>((requestId) => ({ type: "workspace.push", requestId, projectId: t.projectId, ticketId, target: defaultBranch }), MERGE_WAIT_MS))
        : await whileActive(() => ask<MergeResult>((requestId) => ({ type: "workspace.merge", requestId, projectId: t.projectId, ticketId, target: defaultBranch, message: `Merge "${t.title}" (${ticketId})` }), MERGE_WAIT_MS));
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
      await db.insert(checkResults).values({ companyId: t.companyId, ticketId, sha: t.pullRequestHead, kind: "ci", passed: c.state === "passed", detail: c.state === "failed" ? c.failing.join(", ") || null : null });
      if (c.state === "failed" && t.assigneeAgentId) {
        await deps.work.updateTicket(ticketId, { state: "in_progress", overLimit: true, internal: true });
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
