// Decisions (R19–R22, R32): permission requests the policy engine escalates, questions
// agents raise, engagement offers, stale blockers and stalled runs. Answering one resumes
// whatever was waiting on it. The open queue is ranked by an explainable score (R20).
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  effectiveDueDate,
  evaluatePermission,
  ruleFor,
  rankDecision,
  recommendedVerdict,
  type BlockedTicket,
  alwaysChoices,
  explainPermission,
  type AlwaysChoice,
  type PermissionExplanation,
  type PermissionInfo,
  type PolicyMatch,
  type PolicyOutcome,
  type PolicyRuleSpec,
  type RunnerCommand,
  type RunnerEvent,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { record } from "./activity.js";
import { recordGoalAnswer } from "./goal-check.js";
import { ADD_RULE, policyRulesService } from "./policy-rules.js";
import { effectivePolicy, resolveActor } from "./review-policy.js";
import { LESSONS_CAP, LESSON_DONT_ADD, LESSON_EDIT, LESSON_DROP, LESSON_MAX, LESSON_REPLACE_PREFIX, lessonsFrom, lessonsPageRow, normalizeLesson, writeLesson } from "./project-brief.js";
import { agents, budgetPolicies, companies, decisions, deploys, engagementMessages, engagements, keyResults, milestones, objectives, policyRules, projects, runnerEvents, runners, runs, ticketArtifacts, ticketDependencies, tickets, wakes, wikiPages } from "../db/schema.js";

type PermissionEvent = Extract<RunnerEvent, { type: "run.permission_request" }>;
type Sender = (runnerId: string, command: RunnerCommand) => boolean;

export type DecisionContext =
  | { type: "permission"; runnerId: string; runId: string; requestId: string; plan?: boolean; ticketId?: string | null; explain?: PermissionExplanation; always?: AlwaysChoice[] }
  | { type: "engagement"; engagementId: string }
  | { type: "question" }
  | { type: "stale_blocker"; dependencyId: string; blockedTicketId: string; blockerTicketId: string | null; blockerEngagementId: string | null }
  | { type: "stalled_run"; runnerId: string; runId: string }
  | { type: "deploy"; deployId: string }
  /** The follow-up after a feature ships: did it move its key result? */
  | { type: "goal_check"; featureId: string }
  /** Boss Man updating itself through the host deployer; `infra` ones are only an alert (the owner deploys those at the NAS). */
  | { type: "self_deploy"; target: "server" | "runner"; commit: string; fromCommit: string; runnerChanged?: boolean; infra?: boolean; /** Commit subjects, so the "updated" note says what changed. */ changes?: string[]; result?: { result: string; message: string; at: string } }
  /** The runner update's deadline question (services/maintenance.ts): stop the rest, wait more, or cancel. */
  | { type: "maintenance"; since: string }
  | { type: "review_loop"; ticketId: string; message: string; reviewer: string }
  | { type: "ticket_cap"; ticketId: string }
  | { type: "project_cap"; projectId: string }
  | { type: "budget_limit"; policyId: string }
  | { type: "risk_review"; ticketId: string; reviewer: string }
  /** The merge check was killed or timed out: the owner's call, not the agent's. */
  | { type: "check_stuck"; ticketId: string; command: string; output: string }
  /** A lesson learned from a sent-back review (R-review-lessons), awaiting the owner's call. */
  | { type: "lesson"; ticketId: string; projectId: string; projectName: string; lesson: string }
  /** The lesson is approved but the project's Lessons section is full: pick which line it replaces. */
  | { type: "lesson_replace"; projectId: string; projectName: string; lesson: string }
  /** The CEO's proposals for the team (R62), applied when the owner approves. */
  | { type: "hire"; proposal: { name: string; template?: string; title?: string | null; instructions?: string | null; model?: string | null; fundingSourceId?: string | null; reason?: string }; byAgentId: string }
  | { type: "instructions"; agentId: string; instructions: string; byAgentId: string }
  /** A permission rule the CEO drafted from the owner's plain request; added when they answer ADD_RULE. A "question" kind, so the owner can also answer in their own words. */
  | { type: "rule_proposal"; rule: { name: string; match: PolicyMatch; outcome: PolicyOutcome } };

export const CHASE = "Chase";
export const REASSIGN = "Reassign";
export const DROP = "Drop dependency";
const BOSSMAN_TOOL = /^(mcp__bossman__|mcp\.bossman\.)/;
export const KEEP_WAITING = "Keep waiting";
export const CANCEL_RUN = "Cancel run";
export const RAISE_BUDGET = "Raise it by half";
export const HARD_STOP = "Make it a hard stop";
export const LEAVE_BUDGET = "Leave it";
export const APPROVE_PLAN = "Approve plan";
export const KEEP_PLANNING = "Keep planning";
export const APPROVE_MERGE = "Approve and merge";
export const SEND_IT_BACK = "Send it back";
export const CHECK_AGAIN = "Run the check again";
export const CHECK_SEND_BACK = "Send it back to the agent";
export const CHECK_SKIP = "Merge without the check";
export const DEPLOY = "Deploy";
export const UPDATE_RUNNERS = "Update runners";
export const NOT_NOW = "Not now";
export const STOP_AND_UPDATE = "Stop the remaining runs and update now";
export const KEEP_WAITING_MORE = (minutes: number) => `Keep waiting another ${minutes} min`;
export const CANCEL_UPDATE = "Cancel the update";

export class AnswerError extends Error {}

export type AnswerExtra = {
  assigneeAgentId?: string;
  /** What to tell the agent, e.g. why a plan or a review went back. */
  note?: string;
  /** The owner wrote their own answer to an agent's question instead of picking an option. */
  custom?: boolean;
};

const ALLOW = "Allow once";
const DENY = "Deny";

type WakeHook = (input: { agentId: string; reason: string; ticketId?: string | null; note?: string | null; priority?: number }) => Promise<unknown>;

type EngagementHook = (engagementId: string, approved: boolean) => Promise<unknown>;
type DeployHook = (deployId: string, approved: boolean) => Promise<unknown>;
export type LoopHooks = {
  sendBack(ticketId: string, text: string, reviewer: string): Promise<unknown>;
  stopTicket(ticketId: string): Promise<unknown>;
  raiseCap(ticketId: string): Promise<unknown>;
  /** Merges an approved ticket once the owner has signed off on it (R48). */
  land(ticketId: string, reviewer: string): Promise<unknown>;
  /** Lands again in the background after a check that couldn't finish; `skipChecks` merges without it. */
  landAgain(ticketId: string, skipChecks: boolean): Promise<unknown>;
};

export type MaintenanceHook = { answered(answer: string): Promise<unknown> };
export type SelfDeployHook = { check(ctx: Extract<DecisionContext, { type: "self_deploy" }>): Promise<void>; send(ctx: Extract<DecisionContext, { type: "self_deploy" }>, decisionId: string): Promise<unknown> };

type AgentDecisionHook = (ctx: Extract<DecisionContext, { type: "hire" | "instructions" }>, companyId: string, approved: boolean) => Promise<unknown>;

/**
 * What the blockers that just resolved produced, for the "unblocked" wake (R85). An answered
 * decision's dependency row is already gone by then, so its question and answer come in as `answered`.
 */
export async function unblockedNote(db: Db, ticketId: string, answered?: { question: string; answer: string }) {
  const blockers = await db
    .select({ id: tickets.id, title: tickets.title, note: tickets.stateNote, question: decisions.question, answer: decisions.answer })
    .from(ticketDependencies)
    .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
    .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
    .where(eq(ticketDependencies.blockedTicketId, ticketId));
  const ids = blockers.flatMap((b) => (b.id ? [b.id] : []));
  const made = ids.length
    ? await db
        .select({ ticketId: ticketArtifacts.ticketId, title: ticketArtifacts.title, slug: wikiPages.slug })
        .from(ticketArtifacts)
        .leftJoin(wikiPages, eq(wikiPages.id, ticketArtifacts.wikiPageId))
        .where(inArray(ticketArtifacts.ticketId, ids))
    : [];
  const lines = blockers.flatMap((b) => {
    if (b.id) {
      const outs = made.filter((m) => m.ticketId === b.id).map((m) => m.slug ?? m.title);
      return [`- "${b.title}" is done.${b.note ? ` Its note: ${b.note}` : ""}${outs.length ? ` It produced: ${outs.join(", ")}.` : ""}`];
    }
    return b.question && b.answer ? [`- You asked "${b.question}"; the answer was: ${b.answer}`] : [];
  });
  if (answered) lines.push(`- You asked "${answered.question}"; the answer was: ${answered.answer}`);
  return lines.length ? `What you were waiting on:\n${lines.join("\n")}`.slice(0, 800) : undefined;
}

export function decisionsService(db: Db, send: Sender, now: () => Date = () => new Date(), isConnected: (runnerId: string) => boolean = () => false) {
  let wake: WakeHook | null = null;
  let cancelRun: ((runId: string) => Promise<{ endedHere?: boolean }>) | null = null;
  let onEngagement: EngagementHook | null = null;
  let onDeploy: DeployHook | null = null;
  let onAgentDecision: AgentDecisionHook | null = null;
  let loopHooks: LoopHooks | null = null;
  let selfDeploy: SelfDeployHook | null = null;
  let maintenance: MaintenanceHook | null = null;

  /** What the owner needs to judge a stalled run, worked out when asked (not stored). The last steps come from the run's own transcript. */
  async function stallEvidence(runId: string) {
    const [row] = await db
      .select({ run: runs, agent: agents.name, ticketTitle: tickets.title, runnerId: runners.id, lastSeenAt: runners.lastSeenAt })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(tickets, eq(tickets.id, runs.ticketId))
      .leftJoin(runners, eq(runners.companyId, runs.companyId))
      .where(eq(runs.id, runId));
    if (!row) return null;
    const [last] = await db
      .select({ seq: runnerEvents.seq, type: runnerEvents.type, payload: runnerEvents.payload, at: runnerEvents.occurredAt })
      .from(runnerEvents)
      .where(and(sql`(${runnerEvents.payload}->>'runId') = ${runId}`, inArray(runnerEvents.type, ["run.started", "run.update", "run.workspace", "run.permission_request", "run.ended"])))
      .orderBy(desc(runnerEvents.seq))
      .limit(1);
    const [perm] = await db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open"), sql`(${decisions.context}->>'runId') = ${runId}`))
      .limit(1);
    return {
      runId,
      agent: row.agent,
      ticketId: row.run.ticketId,
      ticket: row.ticketTitle,
      startedAt: row.run.startedAt,
      lastEventAt: row.run.lastEventAt,
      lastStep: last ? { seq: last.seq, type: last.type, at: last.at, event: last.payload } : null,
      runner: { connected: !!row.runnerId && isConnected(row.runnerId), lastSeenAt: row.lastSeenAt },
      waitingOnOwner: !!perm,
    };
  }

  /** A blocked ticket whose blockers are all resolved moves to ready, and its assignee is woken. */
  async function releaseIfFree(ticketId: string, wakeAssignee = true) {
    const deps = await db
      .select({ ticketState: tickets.systemState, engagementStatus: engagements.status, decisionStatus: decisions.status })
      .from(ticketDependencies)
      .leftJoin(tickets, eq(tickets.id, ticketDependencies.blockerTicketId))
      .leftJoin(engagements, eq(engagements.id, ticketDependencies.blockerEngagementId))
      .leftJoin(decisions, eq(decisions.id, ticketDependencies.blockerDecisionId))
      .where(eq(ticketDependencies.blockedTicketId, ticketId));
    const open = deps.some((d) => (d.ticketState && d.ticketState !== "done") || (d.engagementStatus && d.engagementStatus !== "signed_off") || d.decisionStatus === "open");
    if (open) return null;
    const [t] = await db.update(tickets).set({ systemState: "ready", lastActivityAt: now() }).where(and(eq(tickets.id, ticketId), eq(tickets.systemState, "blocked"))).returning();
    if (wakeAssignee && t?.assigneeAgentId && wake) await wake({ agentId: t.assigneeAgentId, ticketId: t.id, reason: "unblocked", note: await unblockedNote(db, t.id) });
    return t ?? null;
  }

  /** Checks an answer's extra input before anything changes. */
  async function validate(d: typeof decisions.$inferSelect, answer: string, extra: AnswerExtra) {
    const ctx = d.context as DecisionContext;
    if (ctx.type === "self_deploy" && (answer === DEPLOY || answer === UPDATE_RUNNERS)) {
      if (!selfDeploy) throw new AnswerError("Self-deploy is not set up on this install.");
      await selfDeploy.check(ctx);
    }
    if (ctx.type === "stale_blocker" && answer === REASSIGN) {
      if (!ctx.blockerTicketId) throw new AnswerError("Only a ticket can be reassigned.");
      if (!extra.assigneeAgentId) throw new AnswerError("Say who to reassign it to (assigneeAgentId).");
      const [t] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ctx.blockerTicketId));
      const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, extra.assigneeAgentId), eq(agents.companyId, t?.companyId ?? "")));
      if (!a) throw new AnswerError("That agent isn't in the blocking ticket's company.");
    }
    if (ctx.type === "lesson" && answer === LESSON_EDIT && !extra.note?.trim()) throw new AnswerError("Say the lesson's corrected wording as the note.");
    if (ctx.type === "lesson_replace" && answer !== LESSON_DONT_ADD && !answer.startsWith(LESSON_REPLACE_PREFIX)) throw new AnswerError(`Answer must be one of the listed lessons, or "${LESSON_DONT_ADD}".`);
  }

  /** Adds the approved lesson to the project's brief, unless the section is full and a line must go first (R-review-lessons). */
  async function answerLessons(d: typeof decisions.$inferSelect, ctx: Extract<DecisionContext, { type: "lesson" }>, answer: string, extra: AnswerExtra) {
    if (answer === LESSON_DROP) return;
    const text = normalizeLesson(answer === LESSON_EDIT ? (extra.note ?? "") : ctx.lesson);
    if (text.length > LESSON_MAX) throw new AnswerError(`A lesson is one line, up to ${LESSON_MAX} characters.`);
    // An edit with no usable note adds nothing: nothing reaches the brief without words behind it.
    if (!text) return;
    const page = await lessonsPageRow(db, d.companyId, ctx.projectId);
    const existing = page ? lessonsFrom(page.body) : [];
    if (existing.includes(text)) return;
    if (existing.length >= LESSONS_CAP) {
      // The section is full: the owner picks which line the new lesson replaces, or leaves it out.
      const unique = [...new Set(existing)];
      await db
        .insert(decisions)
        .values({
          companyId: d.companyId,
          kind: "question",
          question: `The Lessons section of ${ctx.projectName}'s brief is full (${LESSONS_CAP}). Approving the new lesson drops one: which?`,
          options: [...unique.map((l) => `${LESSON_REPLACE_PREFIX}${l}`), LESSON_DONT_ADD],
          recommendedOption: `${LESSON_REPLACE_PREFIX}${unique[0]}`,
          tier: "owner",
          dedupeKey: `lesson-replace:${ctx.projectId}:${text}`,
          context: { type: "lesson_replace", projectId: ctx.projectId, projectName: ctx.projectName, lesson: text } satisfies DecisionContext,
        })
        .onConflictDoNothing();
      return;
    }
    await writeLesson(db, { companyId: d.companyId, projectId: ctx.projectId, projectName: ctx.projectName }, text);
  }

  /** Finishes a replace: the chosen line goes, the new lesson takes its place. */
  async function answerLessonReplace(db: Db, d: typeof decisions.$inferSelect, ctx: Extract<DecisionContext, { type: "lesson_replace" }>, answer: string) {
    if (answer === LESSON_DONT_ADD || !answer.startsWith(LESSON_REPLACE_PREFIX)) return;
    const dropped = answer.slice(LESSON_REPLACE_PREFIX.length);
    await writeLesson(db, { companyId: d.companyId, projectId: ctx.projectId, projectName: ctx.projectName }, ctx.lesson, dropped);
  }

  async function answerStaleBlocker(ctx: Extract<DecisionContext, { type: "stale_blocker" }>, answer: string, extra: AnswerExtra) {
    const [blocked] = await db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, ctx.blockedTicketId));
    if (answer === DROP) {
      await db.delete(ticketDependencies).where(eq(ticketDependencies.id, ctx.dependencyId));
      await releaseIfFree(ctx.blockedTicketId);
      return;
    }
    if (ctx.blockerTicketId) {
      const assignee = answer === REASSIGN ? extra.assigneeAgentId! : undefined;
      // Chasing restarts the stale clock; so does a new owner.
      const [t] = await db
        .update(tickets)
        .set({ lastActivityAt: now(), ...(assignee ? { assigneeAgentId: assignee, assignedToOwner: false } : {}) })
        .where(eq(tickets.id, ctx.blockerTicketId))
        .returning();
      if (t?.assigneeAgentId && wake) {
        await wake({
          agentId: t.assigneeAgentId,
          ticketId: t.id,
          reason: assignee ? "assigned" : "chased",
          priority: 3,
          note: `"${blocked?.title ?? "Another ticket"}" is waiting on this ticket${assignee ? ", which has been handed to you" : ", which has had no activity for a while"}. Move it forward, or raise a decision if you're stuck.`,
        });
      }
      return;
    }
    if (ctx.blockerEngagementId) {
      const [eng] = await db.select().from(engagements).where(eq(engagements.id, ctx.blockerEngagementId));
      if (!eng) return;
      await db.insert(engagementMessages).values({ engagementId: eng.id, fromCompanyId: eng.requesterCompanyId, body: `Chasing: "${blocked?.title ?? "our work"}" is waiting on this engagement.` });
      const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, eng.providerCompanyId), eq(agents.role, "ceo")));
      if (ceo && wake) await wake({ agentId: ceo.id, reason: "chased", priority: 3, note: `The engagement "${eng.title}" (${eng.id}) is holding up the requesting company's work. Move it forward, or tell them what's in the way.` });
    }
  }

  async function rulesFor(companyId: string): Promise<PolicyRuleSpec[]> {
    // Company rules before global ones, each in the owner's order (R19).
    const rows = await db
      .select()
      .from(policyRules)
      .where(and(eq(policyRules.trigger, "permission"), or(eq(policyRules.companyId, companyId), isNull(policyRules.companyId))))
      .orderBy(asc(policyRules.position), asc(policyRules.name));
    rows.sort((a, b) => Number(b.companyId !== null) - Number(a.companyId !== null) || a.position - b.position);
    return rows.map((r) => ({ name: r.name, match: r.condition as PolicyRuleSpec["match"], outcome: r.outcome }));
  }

  /** Wakes the company's CEO, or the agent a plan was put to, to answer a decision (R19). */
  async function tellCeo(companyId: string, question: string, agentId?: string) {
    const [ceo] = agentId ? [{ id: agentId }] : await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
    if (ceo && wake) await wake({ agentId: ceo.id, reason: "decision", note: `A decision is waiting for you: ${question}\nUse the decisions tool to read it and answer.` });
  }

  /** A plan from a plan-first ticket, put to the CEO, or to the owner for high-risk work (R40, R48). */
  async function planRequest(runner: { id: string; companyId: string }, event: PermissionEvent) {
    const [run] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(eq(runs.id, event.runId));
    const [t] = run?.ticketId ? await db.select().from(tickets).where(eq(tickets.id, run.ticketId)) : [];
    const [agent] = run?.agentId ? await db.select({ name: agents.name, role: agents.role }).from(agents).where(eq(agents.id, run.agentId)) : [];
    const plan = event.detail ?? null;
    if (t && plan) await db.update(tickets).set({ plan, lastActivityAt: now() }).where(eq(tickets.id, t.id));
    // The review policy says who approves a plan: the owner, the CEO, or an agent. A CEO's own plan always goes to the owner.
    let tier: "owner" | "ceo" = "owner";
    let forAgentId: string | null = null;
    if (t && agent?.role !== "ceo") {
      const ref = ruleFor(await effectivePolicy(db, t), t.risk).planApprover;
      // shortcut: "none" on a plan-first ticket still goes to the CEO (someone must release plan mode); skip only if owners ask for auto-approval.
      if (ref === "none") tier = "ceo";
      else if (ref !== "owner") {
        tier = "ceo";
        const r = await resolveActor(db, t.companyId, ref, run?.agentId ?? null);
        if (r.note) await record(db, { companyId: t.companyId, kind: "review_fallback", summary: r.note, ticketId: t.id });
        if (ref !== "ceo" && !r.note) forAgentId = r.agent?.id ?? null;
      }
    }
    const [row] = await db
      .insert(decisions)
      .values({
        companyId: runner.companyId,
        kind: "approval",
        question: t ? `${agent?.name ?? "An agent"}'s plan for "${t.title}": approve it to start building?` : `${agent?.name ?? "An agent"} has a plan and wants to start building. Approve it?`,
        options: [APPROVE_PLAN, KEEP_PLANNING],
        recommendedOption: APPROVE_PLAN,
        raisedByAgentId: run?.agentId ?? null,
        tier,
        forAgentId,
        dedupeKey: `permission:${event.requestId}`,
        context: { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, plan: true, ticketId: t?.id ?? null, planText: plan },
      })
      .onConflictDoNothing()
      .returning({ id: decisions.id, question: decisions.question });
    if (row && tier === "ceo") await tellCeo(runner.companyId, row.question, forAgentId ?? undefined);
    return { outcome: tier, rule: "Plans are approved before work starts", decisionId: row?.id ?? null };
  }

  return {
    /** Called for every permission request a runner reports. */
    async onPermissionRequest(runner: { id: string; companyId: string }, event: PermissionEvent) {
      // An agent asking to leave plan mode is presenting its plan for approval (R40).
      if (event.kind === "switch_mode") {
        const [r] = await db.select({ purpose: runs.purpose }).from(runs).where(eq(runs.id, event.runId));
        if (r?.purpose !== "chat") return planRequest(runner, event);
      }
      const info: PermissionInfo = { title: event.title, kind: event.kind, rawInput: event.rawInput };
      // The owner chat may use Boss Man's own (board) tools and nothing else.
      const [asking] = await db.select({ purpose: runs.purpose }).from(runs).where(eq(runs.id, event.runId));
      const { outcome, rule } =
        asking?.purpose === "chat"
          ? BOSSMAN_TOOL.test(event.title ?? "")
            ? { outcome: "allow" as const, rule: "The owner chat's board tools" }
            : { outcome: "deny" as const, rule: "The owner chat has board tools only" }
          : evaluatePermission(info, await rulesFor(runner.companyId));
      if (outcome === "allow" || outcome === "deny") {
        if (send(runner.id, { type: "permission.decide", runId: event.runId, requestId: event.requestId, verdict: outcome })) return { outcome, rule, decisionId: null };
        // The runner dropped off between sending the request and getting the verdict. The event
        // won't be applied again when it's resent, so keep the verdict as an answered row that
        // goes out when the runner reconnects, like an owner's answer would (R22).
        const [row] = await db
          .insert(decisions)
          .values({
            companyId: runner.companyId,
            kind: "permission",
            question: `Policy ${outcome === "allow" ? "allowed" : "denied"}: ${typeof (event.rawInput as { command?: unknown } | null)?.command === "string" ? (event.rawInput as { command: string }).command : (event.title ?? "a tool")}`,
            options: [ALLOW, DENY],
            recommendedOption: outcome === "allow" ? ALLOW : DENY,
            status: "answered",
            answer: outcome === "allow" ? ALLOW : DENY,
            answeredAt: now(),
            tier: "ceo",
            dedupeKey: `permission:${event.requestId}`,
            context: { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, rule, delivered: false },
          })
          .onConflictDoNothing()
          .returning({ id: decisions.id });
        return { outcome, rule, decisionId: row?.id ?? null };
      }
      const [run] = await db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, event.runId));
      const [agent] = run?.agentId ? await db.select({ name: agents.name, role: agents.role }).from(agents).where(eq(agents.id, run.agentId)) : [];
      const explain = explainPermission(info, agent?.name ?? "An agent");
      // A CEO never approves its own request: those go to the owner.
      const tier = outcome === "ceo" && agent?.role === "ceo" ? "owner" : outcome;
      // Standing rules are the owner's call, never an agent's.
      const always = tier === "owner" ? alwaysChoices(info, explain) : [];
      const context: DecisionContext = { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, explain, ...(always.length ? { always } : {}) };
      const [row] = await db
        .insert(decisions)
        .values({
          companyId: runner.companyId,
          kind: "permission",
          question: `${explain.title}. ${explain.summary}`,
          options: [ALLOW, ...always.map((a) => a.label), DENY],
          recommendedOption: recommendedVerdict(info) === "deny" ? DENY : ALLOW,
          raisedByAgentId: run?.agentId ?? null,
          tier,
          dedupeKey: `permission:${event.requestId}`,
          context: { ...context, rule },
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id, question: decisions.question });
      if (row && tier === "ceo") await tellCeo(runner.companyId, row.question);
      return { outcome, rule, decisionId: row?.id ?? null };
    },

    async raise(input: { companyId: string; agentId: string | null; question: string; options: string[]; recommended: string; blocksTicketId?: string }) {
      const raised = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(decisions)
          .values({
            companyId: input.companyId,
            kind: "question",
            question: input.question,
            options: input.options,
            recommendedOption: input.recommended,
            raisedByAgentId: input.agentId,
            context: { type: "question" },
          })
          .returning();
        if (input.blocksTicketId) {
          await tx.insert(ticketDependencies).values({ blockedTicketId: input.blocksTicketId, blockerDecisionId: row!.id });
          await tx.update(tickets).set({ systemState: "blocked", lastActivityAt: new Date() }).where(eq(tickets.id, input.blocksTicketId));
        }
        return row!;
      });
      await record(db, { companyId: input.companyId, agentId: input.agentId, ticketId: input.blocksTicketId, kind: "decision_raised", summary: `Asked the owner: ${input.question}`, at: now() });
      return raised;
    },

    /** Re-sends permission verdicts that couldn't be delivered, once the runner is back. */
    async redeliver(runnerId: string) {
      const answered = await db.select().from(decisions).where(and(eq(decisions.kind, "permission"), eq(decisions.status, "answered")));
      let sent = 0;
      for (const d of answered) {
        const ctx = d.context as Extract<DecisionContext, { type: "permission" }> & { delivered?: boolean | "run_ended" };
        if (ctx.delivered !== false || ctx.runnerId !== runnerId) continue;
        const [run] = await db.select({ endedAt: runs.endedAt }).from(runs).where(eq(runs.id, ctx.runId));
        const ok = !run?.endedAt && send(runnerId, { type: "permission.decide", runId: ctx.runId, requestId: ctx.requestId, verdict: d.answer === ALLOW || d.answer === APPROVE_PLAN ? "allow" : "deny" });
        // Delivered, or the run is gone and there's nothing left to deliver to.
        if (ok || run?.endedAt || !run) {
          await db.update(decisions).set({ context: { ...ctx, delivered: ok ? true : "run_ended" } }).where(eq(decisions.id, d.id));
          if (ok) sent++;
        }
      }
      return sent;
    },

    /**
     * Answers again the permission requests a reconnecting runner is still waiting on. A verdict
     * can be lost if the socket drops just after it is sent; the runner would then wait until
     * its timeout. Answered decisions are re-sent; requests the policy decided are decided again
     * from the stored request (the policy is deterministic). Open decisions keep waiting, and
     * requests not stored yet are decided when the runner replays them.
     */
    async resume(runner: { id: string; companyId: string }, pending: Array<{ runId: string; requestId: string }>) {
      let resent = 0;
      for (const p of pending.slice(0, 500)) {
        const [d] = await db.select().from(decisions).where(eq(decisions.dedupeKey, `permission:${p.requestId}`));
        if (d) {
          const ctx = d.context as Extract<DecisionContext, { type: "permission" }>;
          if (d.status !== "answered" || ctx.runnerId !== runner.id || ctx.runId !== p.runId) continue;
          if (send(runner.id, { type: "permission.decide", runId: p.runId, requestId: p.requestId, verdict: d.answer === ALLOW || d.answer === APPROVE_PLAN ? "allow" : "deny" })) resent++;
          continue;
        }
        const [ev] = await db
          .select({ payload: runnerEvents.payload })
          .from(runnerEvents)
          .where(and(eq(runnerEvents.runnerId, runner.id), eq(runnerEvents.type, "run.permission_request"), sql`${runnerEvents.payload}->>'requestId' = ${p.requestId}`, sql`${runnerEvents.payload}->>'runId' = ${p.runId}`))
          .limit(1);
        if (!ev) continue;
        const r = await this.onPermissionRequest(runner, ev.payload as PermissionEvent);
        if (r && (r.outcome === "allow" || r.outcome === "deny")) resent++;
      }
      return resent;
    },

    /** Moves a blocked ticket to ready once nothing blocks it, and wakes its assignee. */
    release: (ticketId: string) => releaseIfFree(ticketId),

    setEngagementHook(hook: EngagementHook) {
      onEngagement = hook;
    },

    setDeployHook(hook: DeployHook) {
      onDeploy = hook;
    },

    setSelfDeployHook(hook: SelfDeployHook) {
      selfDeploy = hook;
    },

    setMaintenanceHook(hook: MaintenanceHook) {
      maintenance = hook;
    },

    setAgentHook(hook: AgentDecisionHook) {
      onAgentDecision = hook;
    },

    setLoopHooks(hooks: LoopHooks) {
      loopHooks = hooks;
    },

    setWakeHook(hook: WakeHook) {
      wake = hook;
    },

    /** How "Cancel run" stops a run: the runs service, which ends the run itself when the runner can't. */
    setCancelHook(hook: (runId: string) => Promise<{ endedHere?: boolean }>) {
      cancelRun = hook;
    },

    async listOpen() {
      return db.select().from(decisions).where(eq(decisions.status, "open")).orderBy(asc(decisions.createdAt));
    },

    /**
     * The owner's queue (R20): every open decision with what it holds up, down the chain,
     * ranked by an explainable score.
     */
    async queue() {
      const t = now();
      const open = await db
        .select({ d: decisions, companyName: companies.name, agentName: agents.name })
        .from(decisions)
        .innerJoin(companies, eq(companies.id, decisions.companyId))
        .leftJoin(agents, eq(agents.id, decisions.raisedByAgentId))
        .where(eq(decisions.status, "open"));
      if (!open.length) return [];
      const forIds = [...new Set(open.map((o) => o.d.forAgentId).filter((x): x is string => !!x))];
      const forNames = new Map(forIds.length ? (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, forIds))).map((a) => [a.id, a.name]) : []);

      // Open work, with the most important objective it serves and its effective due date.
      const work = await db
        .select({
          id: tickets.id,
          title: tickets.title,
          dueDate: tickets.dueDate,
          milestoneTarget: milestones.targetDate,
          krPriority: objectives.priority,
          milestoneObjectiveId: milestones.objectiveId,
        })
        .from(tickets)
        .leftJoin(keyResults, eq(keyResults.id, tickets.keyResultId))
        .leftJoin(objectives, eq(objectives.id, keyResults.objectiveId))
        .leftJoin(milestones, eq(milestones.id, tickets.milestoneId))
        .where(ne(tickets.systemState, "done"));
      const msObjectives = [...new Set(work.map((w) => w.milestoneObjectiveId).filter((x): x is string => !!x))];
      const msPriority = new Map(
        msObjectives.length ? (await db.select({ id: objectives.id, p: objectives.priority }).from(objectives).where(inArray(objectives.id, msObjectives))).map((o) => [o.id, o.p]) : [],
      );
      const info = new Map(
        work.map((w) => {
          const ps = [w.krPriority, w.milestoneObjectiveId ? msPriority.get(w.milestoneObjectiveId) : undefined].filter((p): p is number => p != null);
          return [w.id, { title: w.title, dueDate: effectiveDueDate(w.dueDate, w.milestoneTarget), objectivePriority: ps.length ? Math.min(...ps) : null }];
        }),
      );
      const deps = await db.select().from(ticketDependencies);
      const dependents = new Map<string, string[]>();
      for (const dep of deps) {
        if (!dep.blockerTicketId) continue;
        dependents.set(dep.blockerTicketId, [...(dependents.get(dep.blockerTicketId) ?? []), dep.blockedTicketId]);
      }

      // Tickets a decision holds up directly, by kind.
      const runIds = open.flatMap(({ d }) => {
        const c = d.context as DecisionContext;
        return c.type === "permission" || c.type === "stalled_run" ? [c.runId] : [];
      });
      const runTickets = new Map(runIds.length ? (await db.select({ id: runs.id, ticketId: runs.ticketId }).from(runs).where(inArray(runs.id, runIds))).map((r) => [r.id, r.ticketId]) : []);
      const deployIds = open.flatMap(({ d }) => ((d.context as DecisionContext).type === "deploy" ? [(d.context as { deployId: string }).deployId] : []));
      const deployTickets = new Map(
        deployIds.length ? (await db.select({ id: deploys.id, ticketId: deploys.ticketId }).from(deploys).where(inArray(deploys.id, deployIds))).map((r) => [r.id, r.ticketId]) : [],
      );
      const direct = (d: typeof decisions.$inferSelect): string[] => {
        const c = d.context as DecisionContext;
        switch (c.type) {
          case "permission":
          case "stalled_run": {
            const id = runTickets.get(c.runId);
            return id ? [id] : [];
          }
          case "stale_blocker":
            return [c.blockedTicketId];
          case "deploy": {
            const id = deployTickets.get(c.deployId);
            return id ? [id] : [];
          }
          case "engagement":
            return deps.filter((x) => x.blockerEngagementId === c.engagementId).map((x) => x.blockedTicketId);
          default:
            return deps.filter((x) => x.blockerDecisionId === d.id).map((x) => x.blockedTicketId);
        }
      };

      const rows = open.map(({ d, companyName, agentName }) => {
        // Walk down the chain, nearest first; each ticket counts once.
        const chain: Array<BlockedTicket & { ticketId: string; title: string }> = [];
        const seen = new Set<string>();
        let frontier = direct(d).filter((id) => info.has(id));
        for (let depth = 1; frontier.length && depth <= 10; depth++) {
          const next: string[] = [];
          for (const id of frontier) {
            if (seen.has(id)) continue;
            seen.add(id);
            const i = info.get(id);
            if (!i) continue;
            chain.push({ ticketId: id, title: i.title, depth, dueDate: i.dueDate, objectivePriority: i.objectivePriority });
            next.push(...(dependents.get(id) ?? []));
          }
          frontier = next;
        }
        const rank = rankDecision({ createdAt: d.createdAt, blocked: chain, holdsLiveRun: d.kind === "permission" }, t);
        return { ...d, companyName, agentName, forAgentName: d.forAgentId ? (forNames.get(d.forAgentId) ?? null) : null, blocks: chain, ...rank };
      });
      const sorted = rows.sort((a, b) => b.score - a.score || a.createdAt.getTime() - b.createdAt.getTime());
      return Promise.all(sorted.map(async (r) => ((r.context as DecisionContext).type === "stalled_run" ? { ...r, evidence: await stallEvidence((r.context as { runId: string }).runId) } : r)));
    },

    /** Records the answer and resumes what was waiting. Returns null if not open. */
    async answer(id: string, answer: string, extra: AnswerExtra = {}) {
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
      if (!d) return null;
      const options = d.options as string[];
      // An agent's question can be answered in the owner's own words; anything that acts on the
      // answer (a permission, a deploy, a budget) keeps to its options.
      const ownWords = extra.custom === true && d.kind === "question";
      if (extra.custom && !ownWords) throw new AnswerError("This decision needs one of its options; only an agent's question takes your own answer.");
      if (options.length > 0 && !ownWords && !options.includes(answer)) throw new AnswerError(`Answer must be one of: ${options.join(", ")}`);
      await validate(d, answer, extra);
      const ctx = d.context as DecisionContext;
      // "Allow always" answers this request and adds a rule after the company's own rules, so an owner's deny still wins.
      const always = ctx.type === "permission" ? ctx.always?.find((a) => a.label === answer) : undefined;
      if (always) {
        const [last] = await db.select({ position: policyRules.position }).from(policyRules).where(and(eq(policyRules.trigger, "permission"), eq(policyRules.companyId, d.companyId))).orderBy(desc(policyRules.position)).limit(1);
        const on = now().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        await db.insert(policyRules).values({ companyId: d.companyId, name: `${always.name} (from a request on ${on})`, trigger: "permission", condition: always.match, outcome: "allow", position: (last?.position ?? -1) + 1 });
        answer = ALLOW;
      }
      if (ctx.type === "rule_proposal" && answer === ADD_RULE && !extra.custom) await policyRulesService(db).create({ companyId: d.companyId, ...ctx.rule });
      await db
        .update(decisions)
        // A stale-blocker row frees its key so the blocker can be flagged again if it stalls again.
        .set({ status: "answered", answer, answeredAt: now(), ...(ctx.type === "stale_blocker" || ctx.type === "check_stuck" ? { dedupeKey: null } : {}) })
        .where(eq(decisions.id, id));

      let delivered: boolean | null = null;
      let endedHere = false;
      if (ctx.type === "permission") {
        const allowed = answer === ALLOW || answer === APPROVE_PLAN;
        if (ctx.plan && allowed && ctx.ticketId) await db.update(tickets).set({ planApprovedAt: now() }).where(eq(tickets.id, ctx.ticketId));
        if (ctx.plan && !allowed) {
          // Sent before the verdict, so the agent picks it up as its next turn and keeps planning.
          send(ctx.runnerId, {
            type: "run.message",
            runId: ctx.runId,
            text: `Your plan wasn't approved yet.${extra.note ? ` Feedback: ${extra.note}` : ""} Revise the plan and present it again with ExitPlanMode.`,
            interrupt: false,
          });
        }
        delivered = send(ctx.runnerId, { type: "permission.decide", runId: ctx.runId, requestId: ctx.requestId, verdict: allowed ? "allow" : "deny" });
        if (!delivered) {
          // Never fail silently (R22): flag it, and re-send when the runner reconnects.
          await db.update(decisions).set({ context: { ...ctx, delivered: false } }).where(eq(decisions.id, id));
          await db
            .insert(decisions)
            .values({
              companyId: d.companyId,
              kind: "question",
              question: `Your answer "${answer}" to "${d.question}" couldn't reach the company's runner, which is offline. It will be sent when the runner reconnects. If the agent waits more than 10 minutes, the request is refused.`,
              options: ["Got it"],
              recommendedOption: "Got it",
              dedupeKey: `undelivered:${id}`,
              context: { type: "question" },
            })
            .onConflictDoNothing();
        }
        // The agent resumes now, so the wait for the owner doesn't count as a stall.
        await db.update(runs).set({ lastEventAt: now() }).where(eq(runs.id, ctx.runId));
      } else if (ctx.type === "engagement") {
        await onEngagement?.(ctx.engagementId, answer === "Approve");
      } else if (ctx.type === "deploy") {
        await onDeploy?.(ctx.deployId, answer === "Approve");
      } else if (ctx.type === "self_deploy") {
        if (answer === DEPLOY || answer === UPDATE_RUNNERS) {
          try {
            await selfDeploy!.send(ctx, id);
          } catch (err) {
            // Nothing reached the host, so the question stays open for another try.
            await db.update(decisions).set({ status: "open", answer: null, answeredAt: null }).where(eq(decisions.id, id));
            throw new AnswerError(`The request could not be written for the host deployer: ${(err as Error).message}`);
          }
        }
      } else if (ctx.type === "maintenance") {
        await maintenance?.answered(answer);
      } else if (ctx.type === "hire" || ctx.type === "instructions") {
        await onAgentDecision?.(ctx, d.companyId, answer === "Hire" || answer === "Apply the change");
      } else if (ctx.type === "review_loop" || ctx.type === "ticket_cap") {
        // Free the ticket from this decision first, so the action below sets its final state.
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        if (answer === "Stop work on it") await loopHooks?.stopTicket(ctx.ticketId);
        else if (ctx.type === "review_loop") await loopHooks?.sendBack(ctx.ticketId, ctx.message, ctx.reviewer);
        else await loopHooks?.raiseCap(ctx.ticketId);
      } else if (ctx.type === "project_cap") {
        if (answer === "Raise the cap by half") {
          await db.update(projects).set({ monthlyCapMicros: sql`ceil(${projects.monthlyCapMicros} * 1.5)` }).where(eq(projects.id, ctx.projectId));
          // Work held for the cap can go again.
          await db
            .update(wakes)
            .set({ status: "queued", statusReason: null, notBefore: null })
            .where(and(eq(wakes.status, "deferred"), eq(wakes.statusReason, "project monthly cap reached"), inArray(wakes.ticketId, db.select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, ctx.projectId)))));
        }
      } else if (ctx.type === "risk_review") {
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        if (answer === APPROVE_MERGE) await loopHooks?.land(ctx.ticketId, "the owner");
        else await loopHooks?.sendBack(ctx.ticketId, `The owner sent this back.${extra.note ? ` ${extra.note}` : ""}`, "the owner");
      } else if (ctx.type === "check_stuck") {
        if (answer === CHECK_SEND_BACK) await loopHooks?.sendBack(ctx.ticketId, `The review was approved, but the check \`${ctx.command}\` couldn't finish, so the ticket can't be merged yet. Fix it, then move the ticket back to review.\n\nLast output:\n${ctx.output}`, "the owner");
        else await loopHooks?.landAgain(ctx.ticketId, answer === CHECK_SKIP);
      } else if (ctx.type === "lesson") {
        await answerLessons(d, ctx, answer, extra);
      } else if (ctx.type === "lesson_replace") {
        await answerLessonReplace(db, d, ctx, answer);
      } else if (ctx.type === "budget_limit") {
        const [p] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, ctx.policyId));
        if (p && answer === RAISE_BUDGET) await db.update(budgetPolicies).set({ limitMicros: Math.ceil(p.limitMicros * 1.5) }).where(eq(budgetPolicies.id, p.id));
        if (p && answer === HARD_STOP) await db.update(budgetPolicies).set({ onLimit: "pause" }).where(eq(budgetPolicies.id, p.id));
      } else if (ctx.type === "goal_check") {
        await recordGoalAnswer(db, ctx.featureId, answer, now());
      } else if (ctx.type === "stale_blocker") {
        await answerStaleBlocker(ctx, answer, extra);
      } else if (ctx.type === "stalled_run" && answer === CANCEL_RUN) {
        // A run that already ended needs no stopping.
        const r = await cancelRun?.(ctx.runId).catch(() => null);
        endedHere = !!r?.endedHere;
        delivered = !!r && !r.endedHere;
      }
      // Tickets this decision blocked can move again.
      const freed = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
      await record(db, { companyId: d.companyId, ticketId: freed[0]?.ticketId, kind: "decision_answered", summary: `Owner answered "${d.question}": ${answer}`, at: now() });
      let unblocked: Array<typeof tickets.$inferSelect> = [];
      if (freed.length > 0) {
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        for (const f of freed) {
          const t = await releaseIfFree(f.ticketId, false);
          if (t) unblocked.push(t);
        }
      }
      // The agent that asked is woken with the answer (on the ticket it blocked, if any).
      // A rule proposal answered with a button needs nothing more from the CEO.
      if (wake && d.kind === "question" && d.raisedByAgentId && (ctx.type !== "rule_proposal" || ownWords)) {
        const onTicket = unblocked.find((t) => t.assigneeAgentId === d.raisedByAgentId) ?? unblocked[0];
        await wake({ agentId: d.raisedByAgentId, reason: "decision answered", ticketId: onTicket?.id ?? null, note: `The owner answered your question "${d.question}": ${answer}` });
      }
      for (const t of unblocked) {
        if (wake && t.assigneeAgentId && t.assigneeAgentId !== d.raisedByAgentId) await wake({ agentId: t.assigneeAgentId, reason: "unblocked", ticketId: t.id, note: await unblockedNote(db, t.id, { question: d.question, answer }) });
      }
      return { id, answer, delivered, endedHere };
    },
  };
}
