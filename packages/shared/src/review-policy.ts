// Review routing (step 1): per risk tier, who approves the plan, who reviews the code, and whether the
// owner signs off. A company has a default; a project may override it whole. Step 2 adds "review kinds"
// (security, infra, adversarial) as an optional field on each tier's rule, so stored policies stay valid.
import { z } from "zod";
import { RISK_TIERS, riskOf, type RiskTier } from "./risk.js";

/** Stands for "the company's agent hired from the senior-dev template"; resolved when used, so a later hire just works. */
export const SENIOR_DEV = "senior-dev";
/** The agent template id that SENIOR_DEV looks for. */
export const SENIOR_DEV_TEMPLATE = "senior-dev";

const Actor = z.union([z.enum(["ceo", SENIOR_DEV]), z.string().uuid()]);
/** Extra reviews a tier can require besides the code review. */
export const REVIEW_KINDS = ["security", "infra", "adversarial"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
/** "code" is the tier's ordinary reviewer; the rest are the extra kinds. */
export type ReviewSlot = "code" | ReviewKind;
export const REVIEW_SLOTS: ReviewSlot[] = ["code", ...REVIEW_KINDS];
/** What each kind of reviewer looks for, in the request that wakes them. */
export const KIND_FOCUS: Record<ReviewSlot, string> = {
  code: "correctness, edge cases, tests and fit with the existing design",
  security: "auth, input handling at trust boundaries, secrets, data exposure and new dependencies",
  infra: "CI, containers, deploys, networking, storage, backups, rollback and cost",
  adversarial: "what breaks under hostile, empty, huge or duplicate input, races, retries and partial failure",
};

/** A kind's reviewer: an actor, or "marked" for the agent the owner marked as the company's reviewer of that kind. */
export const MARKED = "marked";
const KindRef = z.union([Actor, z.literal(MARKED)]);
const Rule = z.object({
  planApprover: z.union([Actor, z.enum(["none", "owner"])]),
  reviewer: Actor,
  ownerSignoff: z.boolean(),
  /** A kind that is absent is off. */
  kinds: z.object({ security: KindRef.optional(), infra: KindRef.optional(), adversarial: KindRef.optional() }).optional(),
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
export const policyAgentIds = (p: ReviewPolicy): string[] => RISK_TIERS.flatMap((t) => [p[t].planApprover, p[t].reviewer, ...Object.values(p[t].kinds ?? {})]).filter((v): v is string => !!v && z.string().uuid().safeParse(v).success);
