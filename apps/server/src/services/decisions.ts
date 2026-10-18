// Decisions (R19–R22, R32): permission requests the policy engine escalates, questions
// agents raise, engagement offers, stale blockers and stalled runs. Answering one resumes
// whatever was waiting on it. The open queue is ranked by an explainable score (R20).
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  effectiveDueDate,
  evaluatePermission,
  ownerReviews,
  rankDecision,
  recommendedVerdict,
  type BlockedTicket,
  type PermissionInfo,
  type PolicyRuleSpec,
  type RunnerCommand,
  type RunnerEvent,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, budgetPolicies, companies, decisions, deploys, engagementMessages, engagements, keyResults, milestones, objectives, policyRules, runnerEvents, runs, ticketDependencies, tickets } from "../db/schema.js";

type PermissionEvent = Extract<RunnerEvent, { type: "run.permission_request" }>;
type Sender = (runnerId: string, command: RunnerCommand) => boolean;

export type DecisionContext =
  | { type: "permission"; runnerId: string; runId: string; requestId: string; plan?: boolean; ticketId?: string | null }
  | { type: "engagement"; engagementId: string }
  | { type: "question" }
  | { type: "stale_blocker"; dependencyId: string; blockedTicketId: string; blockerTicketId: string | null; blockerEngagementId: string | null }
  | { type: "stalled_run"; runnerId: string; runId: string }
  | { type: "deploy"; deployId: string }
  | { type: "review_loop"; ticketId: string; message: string; reviewer: string }
  | { type: "ticket_cap"; ticketId: string }
  | { type: "budget_limit"; policyId: string }
  | { type: "risk_review"; ticketId: string; reviewer: string }
  /** The CEO's proposals for the team (R62), applied when the owner approves. */
  | { type: "hire"; proposal: { name: string; template?: string; title?: string | null; instructions?: string | null; model?: string | null; fundingSourceId?: string | null; reason?: string }; byAgentId: string }
  | { type: "instructions"; agentId: string; instructions: string; byAgentId: string };

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
};

type AgentDecisionHook = (ctx: Extract<DecisionContext, { type: "hire" | "instructions" }>, companyId: string, approved: boolean) => Promise<unknown>;

export function decisionsService(db: Db, send: Sender, now: () => Date = () => new Date()) {
  let wake: WakeHook | null = null;
  let onEngagement: EngagementHook | null = null;
  let onDeploy: DeployHook | null = null;
  let onAgentDecision: AgentDecisionHook | null = null;
  let loopHooks: LoopHooks | null = null;

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
    if (wakeAssignee && t?.assigneeAgentId && wake) await wake({ agentId: t.assigneeAgentId, ticketId: t.id, reason: "unblocked" });
    return t ?? null;
  }

  /** Checks an answer's extra input before anything changes. */
  async function validate(d: typeof decisions.$inferSelect, answer: string, extra: AnswerExtra) {
    const ctx = d.context as DecisionContext;
    if (ctx.type === "stale_blocker" && answer === REASSIGN) {
      if (!ctx.blockerTicketId) throw new AnswerError("Only a ticket can be reassigned.");
      if (!extra.assigneeAgentId) throw new AnswerError("Say who to reassign it to (assigneeAgentId).");
      const [t] = await db.select({ companyId: tickets.companyId }).from(tickets).where(eq(tickets.id, ctx.blockerTicketId));
      const [a] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, extra.assigneeAgentId), eq(agents.companyId, t?.companyId ?? "")));
      if (!a) throw new AnswerError("That agent isn't in the blocking ticket's company.");
    }
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

  /** Wakes the company's CEO to answer a decision put to it (R19). */
  async function tellCeo(companyId: string, question: string) {
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
    if (ceo && wake) await wake({ agentId: ceo.id, reason: "decision", note: `A decision is waiting for you: ${question}\nUse the decisions tool to read it and answer.` });
  }

  /** A plan from a plan-first ticket, put to the CEO, or to the owner for high-risk work (R40, R48). */
  async function planRequest(runner: { id: string; companyId: string }, event: PermissionEvent) {
    const [run] = await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(eq(runs.id, event.runId));
    const [t] = run?.ticketId ? await db.select().from(tickets).where(eq(tickets.id, run.ticketId)) : [];
    const [agent] = run?.agentId ? await db.select({ name: agents.name, role: agents.role }).from(agents).where(eq(agents.id, run.agentId)) : [];
    const plan = event.detail ?? null;
    if (t && plan) await db.update(tickets).set({ plan, lastActivityAt: now() }).where(eq(tickets.id, t.id));
    const tier = !t || ownerReviews(t.risk) || agent?.role === "ceo" ? "owner" : "ceo";
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
        dedupeKey: `permission:${event.requestId}`,
        context: { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId, plan: true, ticketId: t?.id ?? null, planText: plan },
      })
      .onConflictDoNothing()
      .returning({ id: decisions.id, question: decisions.question });
    if (row && tier === "ceo") await tellCeo(runner.companyId, row.question);
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
      const what = (event.rawInput as { command?: unknown } | null)?.command;
      const context: DecisionContext = { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId };
      // A CEO never approves its own request: those go to the owner.
      const tier = outcome === "ceo" && agent?.role === "ceo" ? "owner" : outcome;
      const [row] = await db
        .insert(decisions)
        .values({
          companyId: runner.companyId,
          kind: "permission",
          question: `${agent?.name ?? "An agent"} wants to run: ${typeof what === "string" ? what : (event.title ?? "a tool")}`,
          options: [ALLOW, DENY],
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
      return db.transaction(async (tx) => {
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

    setAgentHook(hook: AgentDecisionHook) {
      onAgentDecision = hook;
    },

    setLoopHooks(hooks: LoopHooks) {
      loopHooks = hooks;
    },

    setWakeHook(hook: WakeHook) {
      wake = hook;
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
        return { ...d, companyName, agentName, blocks: chain, ...rank };
      });
      return rows.sort((a, b) => b.score - a.score || a.createdAt.getTime() - b.createdAt.getTime());
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
      await db
        .update(decisions)
        // A stale-blocker row frees its key so the blocker can be flagged again if it stalls again.
        .set({ status: "answered", answer, answeredAt: now(), ...(ctx.type === "stale_blocker" ? { dedupeKey: null } : {}) })
        .where(eq(decisions.id, id));

      let delivered: boolean | null = null;
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
      } else if (ctx.type === "hire" || ctx.type === "instructions") {
        await onAgentDecision?.(ctx, d.companyId, answer === "Hire" || answer === "Apply the change");
      } else if (ctx.type === "review_loop" || ctx.type === "ticket_cap") {
        // Free the ticket from this decision first, so the action below sets its final state.
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        if (answer === "Stop work on it") await loopHooks?.stopTicket(ctx.ticketId);
        else if (ctx.type === "review_loop") await loopHooks?.sendBack(ctx.ticketId, ctx.message, ctx.reviewer);
        else await loopHooks?.raiseCap(ctx.ticketId);
      } else if (ctx.type === "risk_review") {
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        if (answer === APPROVE_MERGE) await loopHooks?.land(ctx.ticketId, "the owner");
        else await loopHooks?.sendBack(ctx.ticketId, `The owner sent this back.${extra.note ? ` ${extra.note}` : ""}`, "the owner");
      } else if (ctx.type === "budget_limit") {
        const [p] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, ctx.policyId));
        if (p && answer === RAISE_BUDGET) await db.update(budgetPolicies).set({ limitMicros: Math.ceil(p.limitMicros * 1.5) }).where(eq(budgetPolicies.id, p.id));
        if (p && answer === HARD_STOP) await db.update(budgetPolicies).set({ onLimit: "pause" }).where(eq(budgetPolicies.id, p.id));
      } else if (ctx.type === "stale_blocker") {
        await answerStaleBlocker(ctx, answer, extra);
      } else if (ctx.type === "stalled_run" && answer === CANCEL_RUN) {
        delivered = send(ctx.runnerId, { type: "run.cancel", runId: ctx.runId });
      }
      // Tickets this decision blocked can move again.
      const freed = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
      let unblocked: Array<typeof tickets.$inferSelect> = [];
      if (freed.length > 0) {
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        for (const f of freed) {
          const t = await releaseIfFree(f.ticketId, false);
          if (t) unblocked.push(t);
        }
      }
      // The agent that asked is woken with the answer (on the ticket it blocked, if any).
      if (wake && d.kind === "question" && d.raisedByAgentId) {
        const onTicket = unblocked.find((t) => t.assigneeAgentId === d.raisedByAgentId) ?? unblocked[0];
        await wake({ agentId: d.raisedByAgentId, reason: "decision answered", ticketId: onTicket?.id ?? null, note: `The owner answered your question "${d.question}": ${answer}` });
      }
      for (const t of unblocked) {
        if (wake && t.assigneeAgentId && t.assigneeAgentId !== d.raisedByAgentId) await wake({ agentId: t.assigneeAgentId, reason: "unblocked", ticketId: t.id });
      }
      return { id, answer, delivered };
    },
  };
}
