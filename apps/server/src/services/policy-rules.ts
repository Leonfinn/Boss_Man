// The owner's decision rules (R19), configurable from v1.1. A rule matches an agent's request
// to use a tool (by kind, command or title) and says what happens: allow it, deny it, or ask
// the CEO or the owner. Company rules are checked first, then rules for every company, then
// the built-in defaults; the first match decides.
import { and, asc, eq, isNull } from "drizzle-orm";
import { DEFAULT_POLICY, evaluatePermission, ruleProblems, type PermissionInfo, type PolicyMatch, type PolicyOutcome, type PolicyRuleSpec } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { policyRules } from "../db/schema.js";

export class RuleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Row = typeof policyRules.$inferSelect;
const view = (r: Row) => ({ id: r.id, companyId: r.companyId, name: r.name, match: r.condition as PolicyMatch, outcome: r.outcome, position: r.position });

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
      return {
        company: companyId ? (await rowsFor(companyId)).map(view) : [],
        global: (await rowsFor(null)).map(view),
        defaults: DEFAULT_POLICY,
      };
    },

    async create(input: { companyId: string | null; name: string; match: PolicyMatch; outcome: PolicyOutcome }) {
      check(input.match);
      const last = await rowsFor(input.companyId);
      const [row] = await db
        .insert(policyRules)
        .values({ companyId: input.companyId, name: input.name, trigger: "permission", condition: input.match, outcome: input.outcome, position: (last.at(-1)?.position ?? -1) + 1 })
        .returning();
      return view(row!);
    },

    async update(id: string, patch: { name?: string; match?: PolicyMatch; outcome?: PolicyOutcome }) {
      if (patch.match) check(patch.match);
      const [row] = await db
        .update(policyRules)
        .set({ ...(patch.name ? { name: patch.name } : {}), ...(patch.match ? { condition: patch.match } : {}), ...(patch.outcome ? { outcome: patch.outcome } : {}) })
        .where(eq(policyRules.id, id))
        .returning();
      if (!row) throw new RuleError(404, "No such rule.");
      return view(row);
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
      return evaluatePermission(info, await effective(companyId));
    },

    effective,
  };
}
