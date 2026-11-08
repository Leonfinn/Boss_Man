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

/**
 * Several agents for one review slot: each review goes to one of them (pickFromList on the server).
 * A list holds agents only; "ceo" and SENIOR_DEV stay single, exclusive choices.
 */
const AgentList = z
  .array(z.string().uuid())
  .min(1)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, "an agent is listed twice");
/**
 * Legacy: "the agent marked as the company's reviewer of that kind" on its agent page. The page no
 * longer sets it and a migration replaced every stored one; it still parses and routes as before,
 * so an old value restored by a retro undo or an old export never breaks a review.
 */
export const MARKED = "marked";
const ReviewerRef = z.union([Actor, AgentList]);
const KindRef = z.union([ReviewerRef, z.literal(MARKED)]);
/** A reviewer cell: one actor, "marked", or a list of agent ids. */
export type ReviewerRefValue = z.infer<typeof KindRef>;
const Rule = z.object({
  planApprover: z.union([Actor, z.enum(["none", "owner"])]),
  reviewer: ReviewerRef,
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

/**
 * The policy with the owner's safeguards from `floor` kept on (BOS-754): at each tier where the floor
 * has the owner signing off or approving the plan, so does the result. Reviewers and review kinds stay
 * as given. For a policy that came from outside (an imported package), which may tighten the defaults
 * but never loosen them; the owner loosens a tier on purpose in Settings. `tightened` says what changed.
 */
export function noLooserThan(policy: ReviewPolicy, floor: ReviewPolicy = DEFAULT_REVIEW_POLICY): { policy: ReviewPolicy; tightened: string[] } {
  const tightened: string[] = [];
  const out = { ...policy };
  for (const tier of RISK_TIERS) {
    const rule = { ...policy[tier] };
    if (floor[tier].ownerSignoff && !rule.ownerSignoff) {
      rule.ownerSignoff = true;
      tightened.push(`your sign-off on ${tier}-risk work`);
    }
    if (floor[tier].planApprover === "owner" && rule.planApprover !== "owner") {
      rule.planApprover = "owner";
      tightened.push(`your approval of ${tier}-risk plans`);
    }
    out[tier] = rule;
  }
  return { policy: out, tightened };
}

/** The rule for a ticket's tier (unrated is medium). */
export const ruleFor = (policy: ReviewPolicy, risk: RiskTier | null | undefined): ReviewRule => policy[riskOf(risk)];

const isUuid = (v: unknown): v is string => typeof v === "string" && z.string().uuid().safeParse(v).success;

/** Every agent id a policy names, for checking they belong to the company. */
export const policyAgentIds = (p: ReviewPolicy): string[] => [...new Set(RISK_TIERS.flatMap((t) => [p[t].planApprover, p[t].reviewer, ...Object.values(p[t].kinds ?? {})].flat()).filter(isUuid))];

/** A slot's ref in a rule; undefined when the kind is off. */
export const slotRef = (rule: ReviewRule, slot: ReviewSlot): ReviewerRefValue | undefined => (slot === "code" ? rule.reviewer : rule.kinds?.[slot]);

/**
 * Which reviews an agent does under a policy, by slot, with the tiers it does them at: for the agent
 * page and the CEO's board, so both read the one source. A senior developer also counts where a cell
 * names SENIOR_DEV. Legacy "marked" cells are left out (the migration replaced them).
 */
export function reviewRolesOf(p: ReviewPolicy, agentId: string, isSeniorDev = false): Array<{ slot: ReviewSlot; tiers: RiskTier[] }> {
  const names = (ref: ReviewerRefValue | undefined) => (Array.isArray(ref) ? ref.includes(agentId) : ref === agentId || (isSeniorDev && ref === SENIOR_DEV));
  return REVIEW_SLOTS.map((slot) => ({ slot, tiers: RISK_TIERS.filter((t) => names(slotRef(p[t], slot))) })).filter((r) => r.tiers.length);
}

/** "Code (all levels), Security (High+)" for what reviewRolesOf returns; "none" when it is empty. */
export function describeRoles(roles: Array<{ slot: ReviewSlot; tiers: RiskTier[] }>): string {
  const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
  const levels = (tiers: RiskTier[]) => {
    if (tiers.length === RISK_TIERS.length) return "all levels";
    const from = RISK_TIERS.indexOf(tiers[0]!);
    // An unbroken run up to Critical reads "High+"; anything else is listed.
    if (from + tiers.length === RISK_TIERS.length && tiers.every((t, i) => RISK_TIERS.indexOf(t) === from + i)) return `${cap(tiers[0]!)}+`;
    return tiers.map(cap).join(", ");
  };
  return roles.length ? roles.map((r) => `${cap(r.slot)} (${levels(r.tiers)})`).join(", ") : "none";
}

/**
 * Replaces legacy "marked" cells with the marked agents (one id, or a list) or the CEO when nobody is
 * marked, as the migration did; for rules written back without the UI (retro undo, import).
 */
export function normaliseMarked<R extends ReviewRule>(rule: R, marks: Partial<Record<ReviewKind, string[]>>): R {
  if (!rule.kinds || !Object.values(rule.kinds).includes(MARKED)) return rule;
  const kinds = { ...rule.kinds };
  for (const k of REVIEW_KINDS) {
    if (kinds[k] !== MARKED) continue;
    const ids = marks[k] ?? [];
    kinds[k] = ids.length === 0 ? "ceo" : ids.length === 1 ? ids[0]! : ids;
  }
  return { ...rule, kinds };
}

export const normalisePolicyMarked = (p: ReviewPolicy, marks: Partial<Record<ReviewKind, string[]>>): ReviewPolicy =>
  Object.fromEntries(RISK_TIERS.map((t) => [t, normaliseMarked(p[t], marks)])) as ReviewPolicy;
