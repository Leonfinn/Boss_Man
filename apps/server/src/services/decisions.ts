// Decisions (R19–R22): permission requests the policy engine escalates, questions agents
// raise, and engagement offers. Answering one resumes whatever was waiting on it.
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { evaluatePermission, recommendedVerdict, type PermissionInfo, type PolicyRuleSpec, type RunnerEvent } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, engagements, policyRules, runs, ticketDependencies, tickets } from "../db/schema.js";

type PermissionEvent = Extract<RunnerEvent, { type: "run.permission_request" }>;
type Sender = (runnerId: string, command: { type: "permission.decide"; runId: string; requestId: string; verdict: "allow" | "deny" }) => boolean;

export type DecisionContext =
  | { type: "permission"; runnerId: string; runId: string; requestId: string }
  | { type: "engagement"; engagementId: string }
  | { type: "question" };

const ALLOW = "Allow once";
const DENY = "Deny";

export function decisionsService(db: Db, send: Sender) {
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

    async listOpen() {
      return db.select().from(decisions).where(eq(decisions.status, "open")).orderBy(asc(decisions.createdAt));
    },

    /** Records the answer and resumes what was waiting. Returns null if not open. */
    async answer(id: string, answer: string) {
      const [d] = await db.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.status, "open")));
      if (!d) return null;
      const options = d.options as string[];
      if (options.length > 0 && !options.includes(answer)) throw new Error(`Answer must be one of: ${options.join(", ")}`);
      await db.update(decisions).set({ status: "answered", answer, answeredAt: new Date() }).where(eq(decisions.id, id));

      const ctx = d.context as DecisionContext;
      let delivered: boolean | null = null;
      if (ctx.type === "permission") {
        delivered = send(ctx.runnerId, { type: "permission.decide", runId: ctx.runId, requestId: ctx.requestId, verdict: answer === ALLOW ? "allow" : "deny" });
      } else if (ctx.type === "engagement") {
        await db.update(engagements).set({ status: answer === "Accept" ? "accepted" : "rejected" }).where(eq(engagements.id, ctx.engagementId));
      }
      // Tickets this decision blocked can move again.
      const freed = await db.select({ ticketId: ticketDependencies.blockedTicketId }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
      if (freed.length > 0) {
        await db.delete(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, id));
        await db
          .update(tickets)
          .set({ systemState: "ready", lastActivityAt: new Date() })
          .where(and(inArray(tickets.id, freed.map((f) => f.ticketId)), eq(tickets.systemState, "blocked")));
      }
      return { id, answer, delivered };
    },
  };
}
