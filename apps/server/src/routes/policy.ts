// Permission and policy routes: review routing, standing rules, decision (permission) rules and
// the grants that back them. Moved out of app.ts unchanged (BOS-298 step 15). The risk-tier help
// lives in routes/settings-limits.ts, which main moved first.
// The caller passes its owner scope, so requireOwner and the app's error handler still apply:
// this registers routes on that instance rather than through app.register, which would add a new scope.
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { RuleMatchSchema, TOOL_KINDS } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies } from "../db/schema.js";
import { record } from "../services/activity.js";
import { PERMISSION_REPORT_MAX_HOURS, permissionReport } from "../services/permission-report.js";
import { RuleError, type policyRulesService } from "../services/policy-rules.js";
import { checkPolicy as checkPolicyIn } from "../services/review-policy.js";
import type { schedulerService } from "../services/scheduler.js";
import type { secretsService } from "../services/secrets.js";
import { getStandingRules, setStandingRules, standingRulesError, STANDING_RULES_MAX, undoStandingRules } from "../services/standing-rules.js";

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

export function policyRoutes(
  owner: FastifyInstance,
  db: Db,
  deps: {
    scheduler: ReturnType<typeof schedulerService>;
    secretsSvc: ReturnType<typeof secretsService>;
    rules: ReturnType<typeof policyRulesService>;
  },
) {
  const { scheduler, secretsSvc, rules } = deps;

  // Review routing: per risk tier, who approves plans, who reviews code and whether the owner signs off.
  // Validates the policy, and that every agent it names belongs to the company.
  const checkPolicy = (companyId: string, body: unknown) => checkPolicyIn(db, companyId, body);
  owner.get("/api/companies/:id/review-policy", async (req, reply) => {
    const [c] = await db.select({ policy: companies.reviewPolicy }).from(companies).where(eq(companies.id, IdParam.parse(req.params).id));
    return c ? c.policy : reply.code(404).send({ error: "not_found" });
  });
  owner.put("/api/companies/:id/review-policy", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const p = await checkPolicy(id, req.body);
    if (typeof p === "string") return reply.code(400).send({ error: "invalid_review_policy", message: p });
    const [c] = await db.update(companies).set({ reviewPolicy: p }).where(eq(companies.id, id)).returning({ policy: companies.reviewPolicy });
    if (!c) return reply.code(404).send({ error: "not_found" });
    // A line in the log, so a surprise in who reviewed a ticket can be traced to when the policy changed (BOS-1969).
    await record(db, { companyId: id, kind: "settings", summary: "Owner changed the review policy" });
    return c.policy;
  });
  // Owner-tier permission cards by deciding rule, across every company (BOS-1456). Read-only.
  owner.get("/api/permission-report", async (req, reply) => {
    const q = z.object({ hours: z.coerce.number().int().min(1).max(PERMISSION_REPORT_MAX_HOURS).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_hours", message: `hours must be a whole number from 1 to ${PERMISSION_REPORT_MAX_HOURS}.` });
    return permissionReport(db, { hours: q.data.hours });
  });
  // A project's own review policy is routes/projects.ts, registered with the project routes.
  // Standing rules (BOS-353): the owner or the CEO sets a short block every agent reads at the start of every run.
  owner.get("/api/companies/:id/standing-rules", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
    if (!c) return reply.code(404).send({ error: "not_found" });
    return { ...(await getStandingRules(db, id)), max: STANDING_RULES_MAX };
  });
  // The owner's change is kept in the company CEO's history too, so the same Undo works for either of them.
  const standingRulesCeo = async (companyId: string) => (await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt))))[0]?.id ?? null;
  owner.put("/api/companies/:id/standing-rules", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ text: z.string() }).parse(req.body);
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
    if (!c) return reply.code(404).send({ error: "not_found" });
    const problem = standingRulesError(b.text.replace(/\r\n/g, "\n").trim());
    if (problem) return reply.code(400).send({ error: "invalid_standing_rules", message: problem });
    try {
      const saved = await setStandingRules(db, id, { text: b.text, by: "the owner", byAgentId: await standingRulesCeo(id) });
      await record(db, { companyId: id, kind: "settings", summary: saved.text ? "Owner updated the standing rules" : "Owner cleared the standing rules" });
      return { ...saved, max: STANDING_RULES_MAX };
    } catch (err) {
      if (err instanceof Error && err.name === "StandingRulesError") return reply.code(400).send({ error: "invalid_standing_rules", message: err.message });
      throw err;
    }
  });
  owner.post("/api/companies/:id/standing-rules/undo", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const ceo = await standingRulesCeo(id);
    if (!ceo) return reply.code(404).send({ error: "not_found" });
    try {
      const saved = await undoStandingRules(db, id, ceo);
      await record(db, { companyId: id, kind: "settings", summary: "Owner undid the last standing rules change" });
      return { ...saved, max: STANDING_RULES_MAX };
    } catch (err) {
      if (err instanceof Error && err.name === "StandingRulesError") return reply.code(409).send({ error: "cannot_undo_standing_rules", message: err.message });
      throw err;
    }
  });

  // Decision rules (R19): what happens when an agent asks to use a tool.
  const Match = RuleMatchSchema;
  const Outcome = z.enum(["allow", "ceo", "owner", "deny"]);
  const ruleErrors = (reply: FastifyReply) => (err: unknown) => {
    if (err instanceof RuleError) return reply.code(err.status).send({ error: "rejected", message: err.message });
    throw err;
  };
  owner.get("/api/policy-rules", async (req) => rules.list(z.object({ companyId: Uuid.optional() }).parse(req.query).companyId ?? null));
  // Every change leaves a "settings" activity line (BOS-1963). A rule for every company (companyId null)
  // has no single company, so the same line is recorded against each company.
  const noteRuleChange = async (companyId: string | null, summary: string, detail: Record<string, unknown>) => {
    const ids = companyId ? [companyId] : (await db.select({ id: companies.id }).from(companies)).map((c) => c.id);
    for (const id of ids) await record(db, { companyId: id, kind: "settings", summary, detail });
  };
  const scopeText = (companyId: string | null) => (companyId ? "" : " for every company");
  owner.post("/api/policy-rules", async (req, reply) => {
    const b = z.object({ companyId: Uuid.nullable(), name: z.string().trim().min(1).max(120), match: Match, outcome: Outcome }).parse(req.body);
    return rules.create(b).then(async (r) => {
      await noteRuleChange(r.companyId, `Owner added the permission rule "${r.name}"${scopeText(r.companyId)} (outcome: ${r.outcome})`, { ruleId: r.id, change: "created", outcome: r.outcome });
      return reply.code(201).send(r);
    }, ruleErrors(reply));
  });
  owner.patch("/api/policy-rules/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(120), match: Match, outcome: Outcome }).partial().parse(req.body);
    const before = await rules.get(id);
    return rules.update(id, b).then(async (r) => {
      const fields: string[] = [];
      if (b.name !== undefined && b.name !== before?.name) fields.push("name");
      if (b.match !== undefined && JSON.stringify(r.match) !== JSON.stringify(before?.match))fields.push("what it matches");
      if (b.outcome !== undefined && b.outcome !== before?.outcome) fields.push("outcome");
      const edited = fields.length ? fields.join(", ") : "nothing changed";
      const renamed = before && before.name !== r.name ? ` (was "${before.name}")` : "";
      await noteRuleChange(r.companyId, `Owner edited the permission rule "${r.name}"${renamed}${scopeText(r.companyId)}: ${edited}; outcome now ${r.outcome}`, { ruleId: r.id, change: "edited", fields, outcome: r.outcome, previousOutcome: before?.outcome ?? null });
      return r;
    }).catch(ruleErrors(reply));
  });
  owner.delete("/api/policy-rules/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const before = await rules.get(id);
    return rules.remove(id).then(async () => {
      if (before) await noteRuleChange(before.companyId, `Owner deleted the permission rule "${before.name}"${scopeText(before.companyId)} (outcome was ${before.outcome})`, { ruleId: id, change: "deleted", outcome: before.outcome });
      return reply.code(204).send();
    }, ruleErrors(reply));
  });
  owner.post("/api/policy-rules/order", async (req, reply) => {
    const b = z.object({ companyId: Uuid.nullable(), ids: z.array(Uuid).max(500) }).parse(req.body);
    return rules.reorder(b.companyId, b.ids).then(async (list) => {
      await noteRuleChange(b.companyId, `Owner reordered the permission rules${scopeText(b.companyId)}: ${list.map((r) => r.name).join(" > ")}`.slice(0, 500), { change: "reordered", order: list.map((r) => r.id) });
      return list;
    }).catch(ruleErrors(reply));
  });
  // The owner asks in plain words; the CEO drafts the rule and it comes back as a decision.
  owner.post("/api/companies/:id/rule-requests", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body);
    const [ceo] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, id), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (!ceo) return reply.code(409).send({ error: "rejected", message: "This company has no CEO to draft the rule." });
    await scheduler.notify(ceo.id, {
      reason: "rule request",
      priority: 3,
      note: `The owner wants a permission rule. In their words: "${text}"\n\nHow rules work: when an agent asks to use a tool, the first matching rule decides. The company's rules are checked in order, then rules for every company, then the built-in defaults. A rule matches on kinds (${TOOL_KINDS.join(", ")}), commandPattern (a regex on the shell command), titlePattern (a regex on the tool's title; MCP tools are titled mcp__<server>__<tool>), and its outcome is allow, ceo (you decide), owner (they decide) or deny.\n\nCall propose_rule once, with a plain-English explanation for a non-developer: what the rule matches, what happens, and examples of requests it would and wouldn't catch. The owner will add it or answer in their own words.`,
    });
    return reply.code(202).send({ ceo });
  });
  owner.post("/api/policy-rules/test", async (req, reply) => {
    // `draft` is a rule not saved yet (BOS-2188): tried first, never stored. A bad pattern is a 422 with the reason.
    const b = z.object({ companyId: Uuid, command: z.string().max(5000).optional(), title: z.string().max(500).optional(), kind: z.string().max(40).optional(), draft: z.object({ match: Match, outcome: Outcome }).optional() }).parse(req.body);
    try {
      return await rules.test(b.companyId, { title: b.title ?? b.command ?? null, kind: b.kind ?? (b.command ? "execute" : null), rawInput: b.command ? { command: b.command } : null }, b.draft);
    } catch (err) {
      return ruleErrors(reply)(err);
    }
  });

  owner.delete("/api/grants/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    return (await secretsSvc.revoke(id)) ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
  });

  owner.put("/api/grants/:id/agents", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { agentIds } = z.object({ agentIds: z.array(Uuid).max(200) }).parse(req.body);
    const r = await secretsSvc.setGrantAgents(id, agentIds);
    if (r.ok) return reply.code(204).send();
    return r.reason === "not_found" ? reply.code(404).send({ error: "not_found" }) : reply.code(400).send({ error: "invalid_agents", message: "Every agent must belong to the grant's company." });
  });
}
