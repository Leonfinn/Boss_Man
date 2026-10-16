// Decisions (R19–R22, R32): permission requests the policy engine escalates, questions
// agents raise, engagement offers, stale blockers and stalled runs. Answering one resumes
// whatever was waiting on it. The open queue is ranked by an explainable score (R20).
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  effectiveDueDate,
  evaluatePermission,
  rankDecision,
  recommendedVerdict,
  type BlockedTicket,
  type PermissionInfo,
  type PolicyRuleSpec,
  type RunnerCommand,
  type RunnerEvent,
} from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, engagementMessages, engagements, keyResults, milestones, objectives, policyRules, runs, ticketDependencies, tickets } from "../db/schema.js";

type PermissionEvent = Extract<RunnerEvent, { type: "run.permission_request" }>;
type Sender = (runnerId: string, command: RunnerCommand) => boolean;

export type DecisionContext =
  | { type: "permission"; runnerId: string; runId: string; requestId: string }
  | { type: "engagement"; engagementId: string }
  | { type: "question" }
  | { type: "stale_blocker"; dependencyId: string; blockedTicketId: string; blockerTicketId: string | null; blockerEngagementId: string | null }
  | { type: "stalled_run"; runnerId: string; runId: string };

export const CHASE = "Chase";
export const REASSIGN = "Reassign";
export const DROP = "Drop dependency";
export const KEEP_WAITING = "Keep waiting";
export const CANCEL_RUN = "Cancel run";

export class AnswerError extends Error {}

export type AnswerExtra = { assigneeAgentId?: string };

const ALLOW = "Allow once";
const DENY = "Deny";

type WakeHook = (input: { agentId: string; reason: string; ticketId?: string | null; note?: string | null; priority?: number }) => Promise<unknown>;

export function decisionsService(db: Db, send: Sender, now: () => Date = () => new Date()) {
  let wake: WakeHook | null = null;

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
    const rows = await db
      .select()
      .from(policyRules)
      .where(and(eq(policyRules.trigger, "permission"), or(eq(policyRules.companyId, companyId), isNull(policyRules.companyId))))
      .orderBy(asc(policyRules.position));
    // Company rules before global ones.
    rows.sort((a, b) => Number(b.companyId !== null) - Number(a.companyId !== null) || a.position - b.position);
    return rows.map((r) => ({ name: r.name, match: r.condition as PolicyRuleSpec["match"], outcome: r.outcome }));
  }

  return {
    /** Called for every permission request a runner reports. */
    async onPermissionRequest(runner: { id: string; companyId: string }, event: PermissionEvent) {
      const info: PermissionInfo = { title: event.title, kind: event.kind, rawInput: event.rawInput };
      const { outcome, rule } = evaluatePermission(info, await rulesFor(runner.companyId));
      if (outcome === "allow" || outcome === "deny") {
        send(runner.id, { type: "permission.decide", runId: event.runId, requestId: event.requestId, verdict: outcome });
        return { outcome, rule, decisionId: null };
      }
      const [run] = await db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, event.runId));
      const [agent] = run?.agentId ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, run.agentId)) : [];
      const what = (event.rawInput as { command?: unknown } | null)?.command;
      const context: DecisionContext = { type: "permission", runnerId: runner.id, runId: event.runId, requestId: event.requestId };
      const [row] = await db
        .insert(decisions)
        .values({
          companyId: runner.companyId,
          kind: "permission",
          question: `${agent?.name ?? "An agent"} wants to run: ${typeof what === "string" ? what : (event.title ?? "a tool")}`,
          options: [ALLOW, DENY],
          recommendedOption: recommendedVerdict(info) === "deny" ? DENY : ALLOW,
          raisedByAgentId: run?.agentId ?? null,
          tier: outcome,
          dedupeKey: `permission:${event.requestId}`,
          context: { ...context, rule },
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id });
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

    async offerEngagement(engagementId: string) {
      const [eng] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
      if (!eng) return null;
      const [from] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, eng.requesterCompanyId));
      const [row] = await db
        .insert(decisions)
        .values({
          companyId: eng.providerCompanyId,
          kind: "engagement",
          question: `${from?.name ?? "A company"} asks: ${eng.title}`,
          options: ["Accept", "Decline"],
          recommendedOption: "Accept",
          context: { type: "engagement", engagementId },
          dedupeKey: `engagement:${engagementId}`,
        })
        .returning();
      return row!;
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
      if (options.length > 0 && !options.includes(answer)) throw new AnswerError(`Answer must be one of: ${options.join(", ")}`);
      await validate(d, answer, extra);
      const ctx = d.context as DecisionContext;
      await db
        .update(decisions)
        // A stale-blocker row frees its key so the blocker can be flagged again if it stalls again.
        .set({ status: "answered", answer, answeredAt: now(), ...(ctx.type === "stale_blocker" ? { dedupeKey: null } : {}) })
        .where(eq(decisions.id, id));

      let delivered: boolean | null = null;
      if (ctx.type === "permission") {
        delivered = send(ctx.runnerId, { type: "permission.decide", runId: ctx.runId, requestId: ctx.requestId, verdict: answer === ALLOW ? "allow" : "deny" });
        // The agent resumes now, so the wait for the owner doesn't count as a stall.
        await db.update(runs).set({ lastEventAt: now() }).where(eq(runs.id, ctx.runId));
      } else if (ctx.type === "engagement") {
        await db.update(engagements).set({ status: answer === "Accept" ? "accepted" : "rejected" }).where(eq(engagements.id, ctx.engagementId));
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
