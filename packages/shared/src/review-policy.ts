// Review routing (step 1): per risk tier, who approves the plan, who reviews the code, and whether the
// owner signs off. A company has a default; a project may override it whole. Step 2 adds "review kinds"
// (security, infra, ...) as an optional field on each tier's rule, so stored policies stay valid.
import { z } from "zod";
import { RISK_TIERS, riskOf, type RiskTier } from "./risk.js";

/** Stands for "the company's agent hired from the senior-dev template"; resolved when used, so a later hire just works. */
export const SENIOR_DEV = "senior-dev";
/** The agent template id that SENIOR_DEV looks for. */
export const SENIOR_DEV_TEMPLATE = "senior-dev";

const Actor = z.union([z.enum(["ceo", SENIOR_DEV]), z.string().uuid()]);
const Rule = z.object({
  planApprover: z.union([Actor, z.enum(["none", "owner"])]),
  reviewer: Actor,
  ownerSignoff: z.boolean(),
});
export const ReviewPolicySchema = z.object({ trivial: Rule, low: Rule, medium: Rule, high: Rule, critical: Rule });
export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;
export type ReviewRule = z.infer<typeof Rule>;

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  trivial: { planApprover: "none", reviewer: "ceo", ownerSignoff: false },
  low: { planApprover: "ceo", reviewer: "ceo", ownerSignoff: false },
  medium: { planApprover: "ceo", reviewer: SENIOR_DEV, ownerSignoff: false },
  high: { planApprover: "owner", reviewer: SENIOR_DEV, ownerSignoff: true },
  critical: { planApprover: "owner", reviewer: SENIOR_DEV, ownerSignoff: true },
};

/** The rule for a ticket's tier (unrated is medium). */
export const ruleFor = (policy: ReviewPolicy, risk: RiskTier | null | undefined): ReviewRule => policy[riskOf(risk)];

/** Every agent id a policy names, for checking they belong to the company. */
export const policyAgentIds = (p: ReviewPolicy): string[] => RISK_TIERS.flatMap((t) => [p[t].planApprover, p[t].reviewer]).filter((v) => z.string().uuid().safeParse(v).success);
