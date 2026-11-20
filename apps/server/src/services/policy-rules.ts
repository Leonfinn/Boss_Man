// The owner's decision rules (R19), configurable from v1.1. A rule matches an agent's request
// to use a tool (by kind, command or title) and says what happens: allow it, deny it, or ask
// the CEO or the owner. The order is PERMISSION_TABLE in shared/policy.ts (BOS-307): guards, company deny and allow rules, built-in allows, then company routing rules (CEO/owner) only for requests that would ask. Within the company rules, company ones come before
// rules for every company; the first match in a row decides.
import { and, asc, eq, isNull } from "drizzle-orm";
import { DEFAULT_POLICY, PERMISSION_TABLE, decidePermission, ruleProblems, shadowedRoutingRules, type PermissionInfo, type PolicyMatch, type PolicyOutcome, type PolicyRuleSpec } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, policyRules } from "../db/schema.js";

export const ADD_RULE = "Add this rule";
export const DONT_ADD_RULE = "Don't add";

export class RuleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Row = typeof policyRules.$inferSelect;
const view = (r: Row) => ({ id: r.id, companyId: r.companyId, name: r.name, match: r.condition as PolicyMatch, outcome: r.outcome, position: r.position, createdAt: r.createdAt ? r.createdAt.toISOString() : null, createdBy: r.createdBy, sourceDecisionId: r.sourceDecisionId });

export function policyRulesService(db: Db) {
  const scope = (companyId: string | null) => and(eq(policyRules.trigger, "permission"), companyId ? eq(policyRules.companyId, companyId) : isNull(policyRules.companyId));

  async function rowsFor(companyId: string | null) {
    return db.select().from(policyRules).where(scope(companyId)).orderBy(asc(policyRules.position), asc(policyRules.name));
  }

  /** The rules in the order they're checked for a company's agents. */
  async function effective(companyId: string): Promise<PolicyRuleSpec[]> {
    const rows = [...(await rowsFor(companyId)), ...(await rowsFor(null))];
    return rows.map((r) => ({ name: r.name, match: r.condition as PolicyMatch, outcome: r.outcome }));
  }

  function check(match: PolicyMatch) {
    const problems = ruleProblems(match);
    if (problems.length) throw new RuleError(422, problems.join(" "));
  }

  return {
    async list(companyId: string | null) {
      const company = companyId ? (await rowsFor(companyId)).map(view) : [];
      const global = (await rowsFor(null)).map(view);
      return {
        company,
        global,
        /** Routing rules the built-in allows now cover (BOS-307): they no longer fire for harmless requests. */
        shadowedIds: shadowedRoutingRules([...company, ...global].map((r) => ({ ...r, name: r.id }))).map((r) => r.id),
        defaults: DEFAULT_POLICY,
        table: PERMISSION_TABLE,
      };
    },

    async create(input: { companyId: string | null; name: string; match: PolicyMatch; outcome: PolicyOutcome; createdBy?: string | null; sourceDecisionId?: string | null }) {
      check(input.match);
      const last = await rowsFor(input.companyId);
      const [row] = await db
        .insert(policyRules)
        .values({ companyId: input.companyId, name: input.name, trigger: "permission", condition: input.match, outcome: input.outcome, position: (last.at(-1)?.position ?? -1) + 1, createdAt: new Date(), createdBy: input.createdBy ?? null, sourceDecisionId: input.sourceDecisionId ?? null })
        .returning();
      return view(row!);
    },

    /** The CEO's draft of a rule, queued for the owner. An allow rule is always safeOnly, so a drafted rule can't lift the built-in destructive and push gates. */
    async propose(companyId: string, ceoId: string, input: { name: string; explanation: string; match: PolicyMatch; outcome: PolicyOutcome }) {
      check(input.match);
      const match = input.outcome === "allow" ? { ...input.match, safeOnly: true } : input.match;
      const [d] = await db
        .insert(decisions)
        .values({
          companyId,
          raisedByAgentId: ceoId,
          kind: "question",
          tier: "owner",
          question: `The CEO proposes a rule: ${input.name}\n\n${input.explanation}${input.outcome === "allow" ? "\n\nBecause it allows things, it never overrides the built-in protection against destructive commands and pushes." : ""}`,
          options: [ADD_RULE, DONT_ADD_RULE],
          recommendedOption: ADD_RULE,
          context: { type: "rule_proposal", rule: { name: input.name, match, outcome: input.outcome } },
        })
        .returning({ id: decisions.id });
      return d!.id;
    },

    async update(id: string, patch: { name?: string; match?: PolicyMatch; outcome?: PolicyOutcome }) {
      // An edit that doesn't carry the agent condition keeps it: a rule for one agent must not quietly become company-wide.
      let match = patch.match;
      if (match && !match.agentIds) {
        const [old] = await db.select({ condition: policyRules.condition }).from(policyRules).where(eq(policyRules.id, id));
        const kept = (old?.condition as PolicyMatch | undefined)?.agentIds;
        if (kept) match = { ...match, agentIds: kept };
      }
      if (match) check(match);
      const [row] = await db
        .update(policyRules)
        .set({ ...(patch.name ? { name: patch.name } : {}), ...(match ? { condition: match } : {}), ...(patch.outcome ? { outcome: patch.outcome } : {}) })
        .where(eq(policyRules.id, id))
        .returning();
      if (!row) throw new RuleError(404, "No such rule.");
      return view(row);
    },

    /** One rule as the routes show it, or null; the routes read it before an edit or delete to write the activity line. */
    async get(id: string) {
      const [row] = await db.select().from(policyRules).where(and(eq(policyRules.id, id), eq(policyRules.trigger, "permission")));
      return row ? view(row) : null;
    },

    async remove(id: string) {
      const rows = await db.delete(policyRules).where(eq(policyRules.id, id)).returning({ id: policyRules.id });
      if (!rows.length) throw new RuleError(404, "No such rule.");
    },

    /** Sets the order of one scope's rules; every rule in that scope must be listed once. */
    async reorder(companyId: string | null, ids: string[]) {
      const rows = await rowsFor(companyId);
      const have = new Set(rows.map((r) => r.id));
      if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((id) => !have.has(id))) {
        throw new RuleError(422, "List each of the scope's rules exactly once.");
      }
      await db.transaction(async (tx) => {
        for (const [i, id] of ids.entries()) await tx.update(policyRules).set({ position: i }).where(eq(policyRules.id, id));
      });
      return (await rowsFor(companyId)).map(view);
    },

    /** What would happen to a request from this company's agents, and which rule decides it. */
    async test(companyId: string, info: PermissionInfo) {
      const [c] = await db.select({ on: companies.autoTempCleanup }).from(companies).where(eq(companies.id, companyId));
      return decidePermission(info, await effective(companyId), { autoTempCleanup: c?.on !== false });
    },

    effective,
  };
}
