// Wakes agents and starts runs, inside the launch-safety limits Kandev learned the hard
// way (R30): kill switches, concurrency ceilings, a causation-depth cap, a self-wake rate
// limit and priority order. Before launching it checks budgets and fails closed (R34),
// and holds low-priority work while a subscription window is nearly used up (R33).
import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { agentIdentity, planningGuidance, stateNoteLine, UNTRUSTED_NOTE } from "@boss-man/shared";
import type { ChapterLaunch } from "./chapters.js";
import { CHAT_REASON } from "./chat.js";
import type { Db } from "../db/client.js";
import { agents, companies, costEvents, decisions, engagements, fundingSources, projects, quotaSamples, runners, runs, settings, ticketArtifacts, ticketDependencies, ticketMessages, tickets, wakes, wikiPages, workflowColumns } from "../db/schema.js";
import { issueRunToken } from "../mcp.js";
import { HARD_STOP, LEAVE_BUDGET, RAISE_BUDGET, unblockedNote } from "./decisions.js";
import type { fundingService } from "./funding.js";
import type { runnersService } from "./runners.js";
import { skillsForRun } from "./skills.js";
import { conversationLines } from "./ticket-chat.js";

export type Limits = {
  instance: number;
  company: number;
  agent: number;
  /** Wake chains deeper than this are dropped and reported. */
  maxDepth: number;
  /** Wakes an agent may cause for itself in ten minutes. */
  selfWakesPer10Min: number;
  /** Wakes with no ticket an agent may get in an hour, not counting the owner's own (R68). */
  ticketlessPerHour: number;
  /** Subscription utilisation at which low-priority work waits for the reset. */
  quotaHoldAt: number;
  /** Wakes at or above this priority ignore the quota hold. */
  highPriority: number;
  /**
   * How long an agent's wake for an answered decision waits for more answers, so answering
   * several in a row starts one run, not one each (R68). Each answer waits this long again,
   * up to answerBatchMaxMs after the first.
   */
  answerBatchMs: number;
  answerBatchMaxMs: number;
};

/** Wakes the owner asked for; never limited. A message counts only when no run sent it. */
/** Why the wiki maintainer is woken (R73). */
export const WIKI_REASON = "wiki upkeep";
/** A watcher's report on the tickets it watches (R80). Scheduled by Boss Man, so not counted as ticketless churn. */
export const WATCH_REASON = "ticket watch";
/** An agent's question answered by the owner (decisions.ts). */
export const ANSWER_REASON = "decision answered";
const WATCH_LINE = /^Watch ticket ([0-9a-f-]{36})$/gm;
const OWNER_REASONS = new Set([CHAT_REASON, "woken by owner", "message"]);
const fromOwner = (w: { reason: string; causedByRunId?: string | null }) => OWNER_REASONS.has(w.reason) && (w.reason !== "message" || !w.causedByRunId);

export const DEFAULT_LIMITS: Limits = { instance: 8, company: 4, agent: 1, maxDepth: 8, selfWakesPer10Min: 5, ticketlessPerHour: 6, quotaHoldAt: 0.95, highPriority: 3, answerBatchMs: 2 * 60_000, answerBatchMaxMs: 5 * 60_000 };

export type WakeInput = {
  agentId: string;
  reason: string;
  ticketId?: string | null;
  note?: string | null;
  priority?: number;
  causedByRunId?: string | null;
  /** The wake carries out this approved deploy; its run gets the target's secrets. */
  deployId?: string | null;
  /** Recovery (R42): the interrupted run to pick up from. */
  resumeRunId?: string | null;
};

type Alert = (companyId: string, question: string) => Promise<unknown>;

export function schedulerService(
  db: Db,
  deps: {
    runners: ReturnType<typeof runnersService>;
    funding: ReturnType<typeof fundingService>;
    alert: Alert;
    /** Binds a deploy to its run before launch, so the run's first secrets fetch includes the target. */
    deploys?: { bindRun(deployId: string, runId: string): Promise<unknown>; unbindRun(deployId: string): Promise<unknown> };
    /** CEO continuity: a CEO's runs continue its current chapter's session. */
    /** The owner chat: its runs' folder and prompt. */
    chat?: { cwd(companyId: string, agentId: string): string; prompt(companyId: string, agentId: string): Promise<string>; claim(companyId: string, agentId: string, runId: string): Promise<unknown> };
    chapters?: { forLaunch(agent: typeof agents.$inferSelect, runId: string, wake: string): Promise<ChapterLaunch>; onLaunchFailed(runId: string): Promise<unknown> };
    workspaceRoot?: string;
    limits?: Partial<Limits>;
    now?: () => Date;
    /** Start a pass as soon as a wake is queued (R85); tests that drive ticks themselves turn it off. */
    tickOnWake?: boolean;
    log?: (msg: string) => void;
  },
) {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  let lane: Promise<unknown> = Promise.resolve();
  const now = deps.now ?? (() => new Date());
  const workspaceRoot = deps.workspaceRoot ?? "/home/node/workspaces";

  async function startTicket(ticketId: string) {
    const [t] = await db.select({ state: tickets.systemState, projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId));
    if (t?.state !== "backlog" && t?.state !== "ready") return;
    const [col] = await db
      .select({ id: workflowColumns.id })
      .from(workflowColumns)
      .where(and(eq(workflowColumns.projectId, t.projectId), eq(workflowColumns.systemState, "in_progress")))
      .orderBy(asc(workflowColumns.position))
      .limit(1);
    await db
      .update(tickets)
      .set({ systemState: "in_progress", columnId: col?.id ?? null, lastActivityAt: now() })
      .where(and(eq(tickets.id, ticketId), inArray(tickets.systemState, ["backlog", "ready"])));
  }

  async function globallyPaused() {
    const [row] = await db.select().from(settings).where(eq(settings.key, "paused"));
    return row?.value === true;
  }

  /** The wiki maintainer's standing job, and the tickets finished since its last run (R73). */
  async function wikiDuty(agent: typeof agents.$inferSelect) {
    const [last] = await db.select({ at: runs.startedAt }).from(runs).where(eq(runs.agentId, agent.id)).orderBy(desc(runs.startedAt)).limit(1);
    const finished = await db
      .select({ id: tickets.id, title: tickets.title, outcome: tickets.outcome })
      .from(tickets)
      .where(and(eq(tickets.companyId, agent.companyId), eq(tickets.systemState, "done"), last ? gt(tickets.lastActivityAt, last.at) : undefined))
      .orderBy(desc(tickets.lastActivityAt))
      .limit(20);
    const made = finished.length
      ? await db
          .select({ ticketId: ticketArtifacts.ticketId, kind: ticketArtifacts.kind, title: ticketArtifacts.title, slug: wikiPages.slug, path: ticketArtifacts.path, ref: ticketArtifacts.ref, url: ticketArtifacts.url })
          .from(ticketArtifacts)
          .leftJoin(wikiPages, eq(wikiPages.id, ticketArtifacts.wikiPageId))
          .where(inArray(ticketArtifacts.ticketId, finished.map((t) => t.id)))
      : [];
    return [
      "You are the company's wiki maintainer. Your job is to keep the wiki accurate, tidy and easy to find things in, using the wiki tool:",
      "- Keep an \"Index\" page at the top level (slug index) that lists every folder and its main pages, with a line on each.",
      "- File pages into sensible folders (for example Research, Product, Engineering, How-tos), move strays, and merge duplicates into one page.",
      "- When finished work produced a document, make sure it's in the wiki, linked to its ticket, and linked from related pages. Read the ticket with tickets read, and a document that's only in the repo with tickets file (it reads the ticket's branch even if it was never merged). Copy it into the wiki with the ticket's id. Write a short summary page if a ticket produced something useful but no page.",
      "- Don't change what a page says is true unless another page or a ticket shows it's out of date; then update it and say what changed at the bottom.",
      "- Don't create tickets or change code; when something needs doing, tell the owner with notify_owner and a link.",
      "",
      finished.length ? "Tickets finished since your last run, newest first:" : "No tickets have finished since your last run; tidy the wiki and the Index page.",
      ...finished.map((t) => {
        const outs = made.filter((m) => m.ticketId === t.id).map((m) => (m.kind === "wiki_page" ? `wiki page ${m.slug}` : m.kind === "url" ? `link ${m.url}` : `repo file ${m.path}${m.ref ? ` on ${m.ref}` : ""}`));
        return `- ${t.id} "${t.title}" (${t.outcome ?? "done"})${outs.length ? `: produced ${outs.join("; ")}` : ": nothing attached"}`;
      }),
    ];
  }

  const ago = (d: Date | null) => {
    if (!d) return "never";
    const m = Math.round((now().getTime() - d.getTime()) / 60_000);
    return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };

  /** What a watcher needs for its report (R80): each watched ticket, its latest run, and what it waits on. */
  async function watchDuty(w: typeof wakes.$inferSelect) {
    const ids = [...new Set([...(w.note ?? "").matchAll(WATCH_LINE)].map((m) => m[1]!))];
    const lines = [
      "You are watching these tickets for the owner, like a scrum master. For each one, check how it's going (the facts below, plus tickets read for more), then post ONE short status update on that ticket with ticket_reply, at most four short lines:",
      "- where it is now and what changed since your last update on it (your earlier updates are in its conversation);",
      "- what it's waiting on, including the tickets and decisions it depends on;",
      "- anything that looks stuck or off track, and what the owner could do about it.",
      "If nothing has changed, say so in one line and say whether it looks stuck. Don't change tickets, code or assignments, and don't wake other agents: only report.",
    ];
    if (!ids.length) return lines;
    const watched = await db
      .select({ t: tickets, assignee: agents.name })
      .from(tickets)
      .leftJoin(agents, eq(agents.id, tickets.assigneeAgentId))
      .where(and(inArray(tickets.id, ids), eq(tickets.watcherAgentId, w.agentId)));
    for (const { t, assignee } of watched) {
      const [last] = await db.select().from(runs).where(eq(runs.ticketId, t.id)).orderBy(desc(runs.startedAt)).limit(1);
      const deps = await db
        .select({ ticket: tickets.title, ticketId: ticketDependencies.blockerTicketId, state: tickets.systemState, activity: tickets.lastActivityAt, decision: decisions.question, decisionStatus: decisions.status, engagement: ticketDependencies.blockerEngagementId })
        .from(ticketDependencies)
        .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
        .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
        .where(eq(ticketDependencies.blockedTicketId, t.id));
      const talk = await conversationLines(db, t.id);
      lines.push(
        "",
        `Ticket ${t.id} "${t.title}"${t.systemState === "done" ? " (now done: give a final update)" : ""}`,
        `- State: ${t.systemState}${t.outcome ? ` (${t.outcome})` : ""}; assigned to ${assignee ?? (t.assignedToOwner ? "the owner" : "nobody")}; last activity ${ago(t.lastActivityAt)}.`,
        last ? `- Latest run: started ${ago(last.startedAt)}, ${last.endedAt ? `ended ${ago(last.endedAt)}${last.outcome ? ` (${last.outcome})` : ""}` : "still running"}.` : "- No runs yet.",
        ...(t.pullRequestUrl ? [`- Pull request: ${t.pullRequestUrl}${t.pullRequestNote ? `, waiting: ${t.pullRequestNote}` : ""}.`] : []),
        ...(deps.length
          ? deps.map((d) =>
              d.ticketId
                ? `- Depends on ticket ${d.ticketId} "${d.ticket}": ${d.state}, last activity ${ago(d.activity)}.`
                : d.decision
                  ? `- Waits on the owner's decision "${d.decision}" (${d.decisionStatus}).`
                  : `- Waits on engagement ${d.engagement}.`,
            )
          : ["- Depends on nothing."]),
        ...(talk.length ? ["- Recent conversation:", ...talk.slice(-4).map((l) => `  ${l}`)] : []),
      );
    }
    return lines;
  }

  /** What a watcher's report would be about, as one string to compare with the last report's (R85). */
  async function watchFacts(x: typeof tickets.$inferSelect) {
    const [last] = await db.select({ id: runs.id, endedAt: runs.endedAt, outcome: runs.outcome }).from(runs).where(eq(runs.ticketId, x.id)).orderBy(desc(runs.startedAt)).limit(1);
    const deps = await db
      .select({ ticket: tickets.systemState, decision: decisions.status, engagement: engagements.status })
      .from(ticketDependencies)
      .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
      .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
      .leftJoin(engagements, eq(engagements.id, ticketDependencies.blockerEngagementId))
      .where(eq(ticketDependencies.blockedTicketId, x.id));
    // The watcher's own updates are left out, or each report would cause the next.
    const [talk] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(ticketMessages)
      .where(and(eq(ticketMessages.ticketId, x.id), sql`${ticketMessages.agentId} is distinct from ${x.watcherAgentId}`));
    return [x.systemState, x.version, x.assigneeAgentId, last ? `${last.id} ${last.endedAt ? (last.outcome ?? "ended") : "running"}` : "no runs", deps.map((d) => d.ticket ?? d.decision ?? d.engagement).join(","), talk?.n].join("|");
  }

  /**
   * Asks each watcher for a report on the tickets that are due (R80): every N minutes while a
   * ticket is open, and once more when it's done. One waiting run per watcher covers them all.
   */
  async function watchDue() {
    const t = now();
    const watched = await db.select().from(tickets).where(sql`${tickets.watcherAgentId} is not null`);
    const dueByTime = watched.filter((x) =>
      x.systemState === "done" ? !!x.watchedAt && x.lastActivityAt > x.watchedAt : !x.watchedAt || t.getTime() - x.watchedAt.getTime() >= (x.watchEveryMinutes ?? 30) * 60_000,
    );
    // A report is asked for only if the ticket's facts changed since the last one, or three checks in a row found nothing new (R85).
    const due: typeof dueByTime = [];
    for (const x of dueByTime) {
      const facts = await watchFacts(x);
      const [skips, last] = (x.watchFingerprint ?? "").split(/:(.*)/s);
      const unchanged = x.systemState !== "done" && !!x.watchedAt && last === facts && Number(skips) < 3;
      await db.update(tickets).set({ watchedAt: t, watchFingerprint: `${unchanged ? Number(skips) + 1 : 0}:${facts}` }).where(eq(tickets.id, x.id));
      if (!unchanged) due.push(x);
    }
    if (!due.length) return;
    const byWatcher = new Map<string, string[]>();
    for (const x of due) byWatcher.set(x.watcherAgentId!, [...(byWatcher.get(x.watcherAgentId!) ?? []), x.id]);
    for (const [agentId, ids] of byWatcher) {
      const add = ids.map((id) => `Watch ticket ${id}`).join("\n");
      const [waiting] = await db
        .select({ id: wakes.id, note: wakes.note })
        .from(wakes)
        .where(and(eq(wakes.agentId, agentId), eq(wakes.reason, WATCH_REASON), inArray(wakes.status, ["queued", "deferred"]), isNull(wakes.runId)));
      if (waiting) await db.update(wakes).set({ note: `${waiting.note ?? ""}\n${add}` }).where(eq(wakes.id, waiting.id));
      else await self.wake({ agentId, reason: WATCH_REASON, note: add, priority: 1 });
    }
  }

  async function prompt(w: typeof wakes.$inferSelect, agent: typeof agents.$inferSelect, companyName: string) {
    const me = agentIdentity(agent, companyName);
    const lines = [`You are ${me.who}, working through Boss Man.`, ...me.instructions];
    if (w.ticketId) {
      const [t] = await db.select({ t: tickets, project: projects.name }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(eq(tickets.id, w.ticketId));
      if (t) {
        lines.push("", `Ticket ${t.t.id} in project "${t.project}" (version ${t.t.version}): ${t.t.title}`);
        if (t.t.body) lines.push("", t.t.body);
        const note = stateNoteLine(t.t, now());
        if (note) lines.push("", note);
        if (t.t.engagementId) lines.push("", `This ticket does work for engagement ${t.t.engagementId}. Use the engagement tool to view it, message the requester, or deliver.`);
        if (t.t.risk) lines.push("", `Risk: ${t.t.risk}.${t.t.risk === "high" || t.t.risk === "critical" ? " The owner reviews it, the project's deeper check runs before it merges, and it deploys to staging before production." : ""}`);
        lines.push("", planningGuidance(t.t.risk));
        if (t.t.planFirst && !t.t.planApprovedAt) lines.push("", "This ticket is plan-first: you're in plan mode. Investigate, then present your plan with ExitPlanMode. Nothing can change until the plan is approved.");
        else if (t.t.plan && t.t.planApprovedAt) lines.push("", "The approved plan for this ticket:", t.t.plan);
        // The ticket's conversation with the owner (R65).
        const talk = await conversationLines(db, t.t.id);
        if (talk.length) lines.push("", "The ticket's conversation so far, oldest first:", ...talk);
      }
    }
    if (agent.duty === "wiki" && !w.ticketId) lines.push("", ...(await wikiDuty(agent)));
    if (w.reason === WATCH_REASON) lines.push("", ...(await watchDuty(w)));
    if (w.note) lines.push("", w.note);
    lines.push(
      "",
      "Look things up before saying you can't: tickets finds and reads any ticket in your company (what it produced, and files from its branch), and wiki reads the company's pages. If you can resolve something with your tools, do it rather than leaving a follow-up note.",
      "Use the bossman tools to report back: ticket_reply to answer the owner on the ticket; wiki write (with the ticket's id) for any document you produce, such as research, a spec or a report, so the owner can read it from the ticket; set_ticket_state with \"review\" when the work is ready to check or \"done\" when it's finished (pass expected_version, the ticket's version above, so a move is refused if the ticket changed since you last saw it; a move to review, done or blocked needs a summary of up to 240 characters, which stays on the ticket for whoever reads it next); raise_decision (with your recommended answer) when you need the owner; create_ticket for follow-up work; request_engagement to ask another company for help.",
      "Ending your turn does not move the ticket.",
      UNTRUSTED_NOTE,
    );
    return lines.join("\n");
  }

  async function launch(w: typeof wakes.$inferSelect): Promise<{ ok: true } | { ok: false; reason: string } | { ok: false; claimed: true }> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, w.agentId));
    const [company] = await db.select().from(companies).where(eq(companies.id, w.companyId));
    const [runner] = await db.select().from(runners).where(eq(runners.companyId, w.companyId));
    if (!agent || !company) return { ok: false, reason: "agent or company gone" };
    if (!runner || !deps.runners.isConnected(runner.id)) return { ok: false, reason: "runner offline" };

    const runId = randomUUID();
    // Claim the wake before any side effect, so it can never start two runs.
    const claimed = await db
      .update(wakes)
      .set({ runId })
      .where(and(eq(wakes.id, w.id), isNull(wakes.runId), inArray(wakes.status, ["queued", "deferred"])))
      .returning({ id: wakes.id });
    if (!claimed.length) return { ok: false, claimed: true };
    // An agent starting on a waiting ticket moves it to in progress, so the board shows what is being worked on; first, so the prompt quotes the bumped version (R81).
    if (w.ticketId) await startTicket(w.ticketId);
    // Work on a provider ticket for an engagement is charged back to the requester (R26).
    const [ticket] = w.ticketId
      ? await db
          .select({ engagementId: tickets.engagementId, projectId: tickets.projectId, repoUrl: projects.repoUrl, defaultBranch: projects.defaultBranch, planFirst: tickets.planFirst, planApprovedAt: tickets.planApprovedAt })
          .from(tickets)
          .innerJoin(projects, eq(projects.id, tickets.projectId))
          .where(eq(tickets.id, w.ticketId))
      : [];
    // The owner chat runs with board tools only, in its own folder, outside the CEO's chapters.
    const chat = w.reason === CHAT_REASON && deps.chat ? deps.chat : null;
    const wakePrompt = chat ? await chat.prompt(w.companyId, w.agentId) : await prompt(w, agent, company.name);
    // A CEO's run belongs to its current chapter (CEO continuity).
    const chapter = !chat && agent.role === "ceo" && deps.chapters ? await deps.chapters.forLaunch(agent, runId, wakePrompt) : null;
    await db.insert(runs).values({ id: runId, companyId: w.companyId, agentId: w.agentId, ticketId: w.ticketId, engagementId: ticket?.engagementId ?? null, chapterId: chapter?.chapterId ?? null, purpose: chat ? "chat" : null, model: agent.model, startedAt: now() });
    if (chat) await chat.claim(w.companyId, w.agentId, runId);
    const mcpToken = await issueRunToken(db, { companyId: w.companyId, agentId: w.agentId, runId });
    if (w.deployId) await deps.deploys?.bindRun(w.deployId, runId);
    // Claude can reopen the interrupted ACP session (spike S4); other agents start fresh.
    const [previous] = w.resumeRunId && agent.agentKind === "claude" ? await db.select({ acpSessionId: runs.acpSessionId }).from(runs).where(eq(runs.id, w.resumeRunId)) : [];
    // The agent's skills (R71) go with the run; chat runs have no built-in tools to use them.
    const skillSet = !chat && agent.agentKind === "claude" ? await skillsForRun(db, agent.id) : [];
    const sent = deps.runners.send(runner.id, {
      type: "run.start",
      runId,
      agentId: agent.id,
      agentKind: agent.agentKind,
      model: agent.model,
      fundingSourceId: agent.fundingSourceId,
      cwd: chat ? chat.cwd(w.companyId, w.agentId) : path.posix.join(workspaceRoot, w.ticketId ?? agent.id),
      ...(chat ? { boardToolsOnly: true } : {}),
      // A ticket in a project with a repo works in its own worktree and branch (R38).
      // A plan-first ticket starts in plan mode until its plan is approved (R40).
      ...(ticket?.planFirst && !ticket.planApprovedAt ? { mode: "plan" as const } : {}),
      ...(ticket?.repoUrl && w.ticketId ? { workspace: { projectId: ticket.projectId, ticketId: w.ticketId, repoUrl: ticket.repoUrl, baseRef: ticket.defaultBranch } } : {}),
      prompt: chapter?.prompt ?? wakePrompt,
      mcpToken,
      ...(chapter?.resumeSessionId ? { resumeSessionId: chapter.resumeSessionId } : !chapter && previous?.acpSessionId ? { resumeSessionId: previous.acpSessionId } : {}),
      ...(chapter?.freshPrompt ? { freshPrompt: chapter.freshPrompt } : {}),
      ...(skillSet.length ? { skills: skillSet } : {}),
    });
    if (!sent) {
      if (w.deployId) await deps.deploys?.unbindRun(w.deployId);
      if (chapter) await deps.chapters?.onLaunchFailed(runId);
      await db.delete(runs).where(eq(runs.id, runId));
      await db.update(wakes).set({ runId: null }).where(eq(wakes.id, w.id));
      return { ok: false, reason: "runner offline" };
    }
    await db.update(wakes).set({ status: "launched", runId, launchedAt: now(), statusReason: null }).where(eq(wakes.id, w.id));
    return { ok: true };
  }

  /** The decision for a soft budget limit that has been passed (R28). */
  async function askAboutBudget(b: Awaited<ReturnType<ReturnType<typeof fundingService>["budgetStatuses"]>>[number], companyId: string) {
    const { policy, status } = b;
    const named =
      policy.scopeKind === "instance"
        ? "All companies together have"
        : policy.scopeKind === "company"
          ? `${(await db.select({ n: companies.name }).from(companies).where(eq(companies.id, policy.scopeId)))[0]?.n ?? "A company"} has`
          : policy.scopeKind === "project"
            ? `The project "${(await db.select({ n: projects.name }).from(projects).where(eq(projects.id, policy.scopeId)))[0]?.n ?? "?"}" has`
            : `The agent ${(await db.select({ n: agents.name }).from(agents).where(eq(agents.id, policy.scopeId)))[0]?.n ?? "?"} has`;
    const window = { billing_cycle: "this billing cycle", calendar_month: "this month", rolling_days: `the last ${policy.rollingDays ?? "?"} days`, lifetime: "in total" }[policy.windowKind] ?? policy.windowKind;
    const usd = (m: number) => `$${(m / 1e6).toFixed(2)}`;
    await db
      .insert(decisions)
      .values({
        companyId,
        kind: "budget",
        question: `${named} used ${usd(status.usedMicros)} of a ${usd(status.limitMicros)} budget ${window}. Work carries on, because this limit only asks. Raise it by half, make it a hard stop, or leave it as it is?`,
        options: [RAISE_BUDGET, HARD_STOP, LEAVE_BUDGET],
        recommendedOption: RAISE_BUDGET,
        dedupeKey: `budget-ask:${policy.id}:${status.bounds.start?.toISOString() ?? "all"}:${policy.limitMicros}`,
        context: { type: "budget_limit", policyId: policy.id },
      })
      .onConflictDoNothing();
  }

  const self = {
    limits,

    /** Queues a wake, or drops it (and tells the owner) if it looks like a loop. */
    async wake(input: WakeInput) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
      if (!agent) throw new Error("No such agent.");
      let depth = 0;
      let causedByAgentId: string | null = null;
      if (input.causedByRunId) {
        const [parent] = await db.select({ depth: wakes.causationDepth }).from(wakes).where(eq(wakes.runId, input.causedByRunId));
        const [run] = await db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, input.causedByRunId));
        depth = (parent?.depth ?? 0) + 1;
        causedByAgentId = run?.agentId ?? null;
      }
      const base = {
        companyId: agent.companyId,
        agentId: agent.id,
        ticketId: input.ticketId ?? null,
        reason: input.reason,
        note: input.note ?? null,
        priority: input.priority ?? 2,
        causationDepth: depth,
        causedByRunId: input.causedByRunId ?? null,
        causedByAgentId,
        deployId: input.deployId ?? null,
        resumeRunId: input.resumeRunId ?? null,
      };

      // Answers to an agent's questions are gathered for a short while, then given to it in one
      // run: the owner often answers several in a row, and each run costs as much as the next (R68).
      if (input.reason === ANSWER_REASON && limits.answerBatchMs > 0) {
        const t = now();
        const [waiting] = await db
          .select()
          .from(wakes)
          .where(
            and(
              eq(wakes.agentId, agent.id),
              eq(wakes.reason, ANSWER_REASON),
              base.ticketId ? eq(wakes.ticketId, base.ticketId) : isNull(wakes.ticketId),
              inArray(wakes.status, ["queued", "deferred"]),
              isNull(wakes.runId),
            ),
          )
          .orderBy(asc(wakes.createdAt))
          .limit(1);
        if (waiting) {
          const latest = Math.min(waiting.createdAt.getTime() + limits.answerBatchMaxMs, t.getTime() + limits.answerBatchMs);
          const notBefore = waiting.status === "deferred" && waiting.notBefore ? new Date(Math.max(waiting.notBefore.getTime(), latest)) : waiting.notBefore;
          const [row] = await db
            .update(wakes)
            .set({ note: [waiting.note, base.note].filter(Boolean).join("\n\n"), priority: Math.max(waiting.priority, base.priority), notBefore })
            .where(eq(wakes.id, waiting.id))
            .returning();
          return row!;
        }
        const [row] = await db.insert(wakes).values({ ...base, status: "deferred", statusReason: "waiting briefly for more answers", notBefore: new Date(t.getTime() + limits.answerBatchMs) }).returning();
        return row!;
      }

      if (depth > limits.maxDepth) {
        const [row] = await db.insert(wakes).values({ ...base, status: "dropped", statusReason: `chain of ${depth} wake-ups exceeds ${limits.maxDepth}` }).returning();
        await deps.alert(agent.companyId, `${agent.name} was woken ${depth} times in a chain, which looks like a loop. The last wake ("${input.reason}") was dropped. Look into it, then wake the agent again if it's fine.`);
        return row!;
      }
      if (causedByAgentId === agent.id) {
        const since = new Date(now().getTime() - 10 * 60_000);
        const recent = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(wakes)
          .where(and(eq(wakes.agentId, agent.id), eq(wakes.causedByAgentId, agent.id), gt(wakes.createdAt, since)));
        if ((recent[0]?.n ?? 0) >= limits.selfWakesPer10Min) {
          const [row] = await db.insert(wakes).values({ ...base, status: "dropped", statusReason: `woke itself more than ${limits.selfWakesPer10Min} times in 10 minutes` }).returning();
          await deps.alert(agent.companyId, `${agent.name} keeps waking itself (more than ${limits.selfWakesPer10Min} times in 10 minutes). New self-wakes are being dropped.`);
          return row!;
        }
      }
      // Runs with no ticket (decisions, triage, chasing) cost as much as ticket work but are easy
      // to set off in a loop, so each agent gets a few an hour. The owner's own chat and wakes
      // always go through (R68).
      if (!base.ticketId && !fromOwner(input) && input.reason !== WATCH_REASON) {
        const since = new Date(now().getTime() - 3_600_000);
        const [recent] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(wakes)
          .where(
            and(
              eq(wakes.agentId, agent.id),
              isNull(wakes.ticketId),
              gt(wakes.createdAt, since),
              sql`${wakes.status} <> 'dropped'`,
              sql`not (${wakes.reason} in (${sql.join([...OWNER_REASONS].map((r) => sql`${r}`), sql`, `)}) and (${wakes.reason} <> 'message' or ${wakes.causedByRunId} is null))`,
              sql`${wakes.reason} <> ${WATCH_REASON}`,
            ),
          );
        if ((recent?.n ?? 0) >= limits.ticketlessPerHour) {
          const statusReason = `more than ${limits.ticketlessPerHour} wakes with no ticket in an hour`;
          // Tell the owner once an hour, not for every wake dropped.
          const [told] = await db
            .select({ id: wakes.id })
            .from(wakes)
            .where(and(eq(wakes.agentId, agent.id), eq(wakes.status, "dropped"), eq(wakes.statusReason, statusReason), gt(wakes.createdAt, since)))
            .limit(1);
          const [row] = await db.insert(wakes).values({ ...base, status: "dropped", statusReason }).returning();
          if (!told) {
            await deps.alert(
              agent.companyId,
              `${agent.name} has been started ${limits.ticketlessPerHour} times in the last hour with no ticket (the latest for "${input.reason}"). Further wakes like that are being dropped for the rest of the hour. See Runs for why each one started.`,
            );
          }
          return row!;
        }
      }
      const [row] = await db.insert(wakes).values(base).returning();
      // Start it now rather than at the next timer pass (R85).
      if (deps.tickOnWake !== false) void this.tick().catch((err) => deps.log?.(`scheduler pass after a wake failed: ${(err as Error).message}`));
      return row!;
    },

    /**
     * One scheduling pass. Safe to call often: passes run one at a time, so two triggers
     * (the timer, a run ending, the API) can't both pass the same concurrency check.
     */
    tick() {
      const pass = lane.then(() => this.tickOnce());
      lane = pass.catch(() => undefined);
      return pass;
    },

    async tickOnce() {
      const result = { launched: 0, deferred: 0, waiting: 0, paused: false };
      if (await globallyPaused()) return { ...result, paused: true };
      await watchDue();

      const t = now();
      const queue = await db
        .select()
        .from(wakes)
        .where(or(eq(wakes.status, "queued"), and(eq(wakes.status, "deferred"), or(isNull(wakes.notBefore), lte(wakes.notBefore, t)))))
        .orderBy(desc(wakes.priority), asc(wakes.createdAt));
      if (queue.length === 0) return result;

      const active = await db.select({ companyId: runs.companyId, agentId: runs.agentId, purpose: runs.purpose }).from(runs).where(isNull(runs.endedAt));
      let total = active.length;
      const byCompany = new Map<string, number>();
      const byAgent = new Map<string, number>();
      // An agent's chat run doesn't hold up its own work, or the other way round: one of each.
      const chatting = new Set<string>();
      for (const r of active) {
        byCompany.set(r.companyId, (byCompany.get(r.companyId) ?? 0) + 1);
        if (r.purpose === "chat") chatting.add(r.agentId ?? r.companyId);
        else if (r.agentId) byAgent.set(r.agentId, (byAgent.get(r.agentId) ?? 0) + 1);
      }

      // Budget admission fails closed: if budgets can't be read, nothing launches.
      let budgets: Awaited<ReturnType<ReturnType<typeof fundingService>["budgetStatuses"]>>;
      try {
        budgets = await deps.funding.budgetStatuses(t);
      } catch {
        await db.update(wakes).set({ status: "deferred", statusReason: "budget check failed", notBefore: new Date(t.getTime() + 60_000) }).where(inArray(wakes.id, queue.map((w) => w.id)));
        return { ...result, deferred: queue.length };
      }
      const paused = new Set((await db.select({ id: companies.id }).from(companies).where(eq(companies.paused, true))).map((c) => c.id));
      const pausedAgents = new Set((await db.select({ id: agents.id }).from(agents).where(eq(agents.paused, true))).map((a) => a.id));

      for (const w of queue) {
        const defer = async (reason: string, notBefore: Date | null) => {
          await db.update(wakes).set({ status: "deferred", statusReason: reason, notBefore }).where(eq(wakes.id, w.id));
          result.deferred++;
        };
        const wait = async (reason: string) => {
          if (w.statusReason !== reason || w.status !== "queued") await db.update(wakes).set({ status: "queued", statusReason: reason }).where(eq(wakes.id, w.id));
          result.waiting++;
        };

        if (paused.has(w.companyId)) {
          await wait("company paused");
          continue;
        }
        if (pausedAgents.has(w.agentId)) {
          await wait("agent paused");
          continue;
        }
        const isChat = w.reason === CHAT_REASON;
        if (total >= limits.instance || (byCompany.get(w.companyId) ?? 0) >= limits.company || (isChat ? chatting.has(w.agentId) : (byAgent.get(w.agentId) ?? 0) >= limits.agent)) {
          await wait("at a concurrency limit");
          continue;
        }

        const [agent] = await db.select().from(agents).where(eq(agents.id, w.agentId));
        const [wt] = w.ticketId
          ? await db
              .select({ projectId: tickets.projectId, title: tickets.title, cap: tickets.costCapMicros, projectCap: projects.ticketCostCapMicros })
              .from(tickets)
              .innerJoin(projects, eq(projects.id, tickets.projectId))
              .where(eq(tickets.id, w.ticketId))
          : [];
        // Instance, company, project and agent budgets all apply (R28, R53).
        const inScope = (b: (typeof budgets)[number]) =>
          b.policy.scopeKind === "instance" ||
          (b.policy.scopeKind === "company" && b.policy.scopeId === w.companyId) ||
          (b.policy.scopeKind === "project" && b.policy.scopeId === wt?.projectId) ||
          (b.policy.scopeKind === "agent" && b.policy.scopeId === w.agentId);
        const stopped = budgets.find((b) => b.status.action === "pause" && inScope(b));
        if (stopped) {
          await defer("budget limit reached", stopped.status.bounds.end ?? null);
          continue;
        }
        // A soft limit asks the owner once per window and limit; the work carries on meanwhile.
        for (const b of budgets.filter((b) => b.status.action === "ask" && inScope(b))) await askAboutBudget(b, w.companyId);

        // A ticket's spend across all its runs has a ceiling, because review and retry loops multiply runs (R53).
        const ticketCap = wt?.cap ?? wt?.projectCap;
        if (w.ticketId && ticketCap != null) {
          const [spent] = await db
            .select({ total: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
            .from(costEvents)
            .innerJoin(runs, eq(runs.id, costEvents.runId))
            .where(eq(runs.ticketId, w.ticketId));
          const total = Number(spent?.total ?? 0);
          if (total >= ticketCap) {
            await db
              .insert(decisions)
              .values({
                companyId: w.companyId,
                kind: "budget",
                question: `"${wt!.title}" has used $${(total / 1e6).toFixed(2)} of its $${(ticketCap / 1e6).toFixed(2)} cap across all its runs. Raise the cap by half, or stop work on it?`,
                options: ["Raise the cap by half", "Stop work on it"],
                recommendedOption: "Stop work on it",
                dedupeKey: `ticket-cap:${w.ticketId}:${ticketCap}`,
                context: { type: "ticket_cap", ticketId: w.ticketId },
              })
              .onConflictDoNothing();
            await defer("ticket cost cap reached", new Date(t.getTime() + 5 * 60_000));
            continue;
          }
        }

        if (agent?.fundingSourceId && w.priority < limits.highPriority) {
          const [source] = await db.select().from(fundingSources).where(eq(fundingSources.id, agent.fundingSourceId));
          if (source?.kind === "subscription") {
            const samples = await db
              .selectDistinctOn([quotaSamples.window])
              .from(quotaSamples)
              .where(eq(quotaSamples.fundingSourceId, source.id))
              .orderBy(quotaSamples.window, desc(quotaSamples.observedAt));
            const full = samples.filter((s) => s.utilization >= limits.quotaHoldAt && (!s.resetsAt || s.resetsAt > t));
            if (full.length) {
              const until = full.reduce<Date | null>((m, s) => (s.resetsAt && (!m || s.resetsAt > m) ? s.resetsAt : m), null);
              await defer(`subscription ${full.map((s) => s.window).join(", ")} window nearly used up`, until);
              continue;
            }
          }
        }

        const launched = await launch(w);
        if (!launched.ok) {
          // Another pass already took it; leave its state alone.
          if ("claimed" in launched) continue;
          await wait(launched.reason);
          continue;
        }
        result.launched++;
        total++;
        byCompany.set(w.companyId, (byCompany.get(w.companyId) ?? 0) + 1);
        if (isChat) chatting.add(w.agentId);
        else byAgent.set(w.agentId, (byAgent.get(w.agentId) ?? 0) + 1);
      }
      return result;
    },

    async setGlobalPause(paused: boolean) {
      await db.insert(settings).values({ key: "paused", value: paused }).onConflictDoUpdate({ target: settings.key, set: { value: paused } });
    },

    async setCompanyPause(companyId: string, paused: boolean) {
      await db.update(companies).set({ paused }).where(eq(companies.id, companyId));
    },

    async queue() {
      return db.select().from(wakes).where(inArray(wakes.status, ["queued", "deferred"])).orderBy(desc(wakes.priority), asc(wakes.createdAt));
    },

    /** Frees a finished ticket's worktree on its company's runner, keeping its branch (R38). */
    async releaseWorkspace(ticketId: string) {
      const [t] = await db
        .select({ companyId: tickets.companyId, projectId: tickets.projectId, repoUrl: projects.repoUrl })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(eq(tickets.id, ticketId));
      if (!t?.repoUrl) return false;
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, t.companyId));
      return runner ? deps.runners.send(runner.id, { type: "workspace.release", projectId: t.projectId, ticketId }) : false;
    },

    /** A ticket went to review: the CEO is woken to review it, unless it moved it or has it itself (R85). */
    async onTicketReview(ticketId: string, byAgentId: string | null, causedByRunId?: string | null) {
      const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      if (!t) return;
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, t.companyId), eq(agents.role, "ceo")));
      if (!ceo || ceo.id === byAgentId || ceo.id === t.assigneeAgentId) return;
      await this.wake({ agentId: ceo.id, ticketId, reason: "review requested", priority: 3, causedByRunId, note: `"${t.title}" is ready for review.${t.stateNote ? ` The agent said: "${t.stateNote}"` : ""} Use the review tool.` });
    },

    /**
     * After a ticket is done: dependents whose blockers are all resolved move to ready,
     * and their assignees are woken. Wakes caused by an agent's run carry the chain depth.
     */
    async onTicketDone(ticketId: string, causedByRunId?: string | null) {
      await this.releaseWorkspace(ticketId);
      const dependents = await db.select({ id: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerTicketId, ticketId));
      for (const { id } of dependents) {
        const blockers = await db
          .select({ state: tickets.systemState })
          .from(ticketDependencies)
          .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
          .where(eq(ticketDependencies.blockedTicketId, id));
        if (blockers.some((b) => b.state !== "done")) continue;
        const [t] = await db.update(tickets).set({ systemState: "ready", lastActivityAt: now() }).where(and(eq(tickets.id, id), eq(tickets.systemState, "blocked"))).returning();
        if (t?.assigneeAgentId) await this.wake({ agentId: t.assigneeAgentId, ticketId: t.id, reason: "unblocked", causedByRunId, note: await unblockedNote(db, t.id) });
      }
      // The wiki maintainer files what finished work produced (R73). One waiting run covers
      // every ticket finished before it starts, and a paused maintainer's run waits.
      const [done] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ticketId));
      const [keeper] = done ? await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, done.companyId), eq(agents.duty, "wiki"))) : [];
      if (keeper) {
        const [waiting] = await db
          .select({ id: wakes.id })
          .from(wakes)
          .where(and(eq(wakes.agentId, keeper.id), eq(wakes.reason, WIKI_REASON), inArray(wakes.status, ["queued", "deferred"])));
        if (!waiting) await this.wake({ agentId: keeper.id, reason: WIKI_REASON, priority: 1, causedByRunId });
      }
    },
  };
  return self;
}
