import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_POLICY, describeRoles, noLooserThan, normaliseMarked, policyAgentIds, ReviewPolicySchema, reviewRolesOf, ruleFor, type ReviewPolicy, type ReviewRule } from "../src/review-policy.js";

describe("review policy", () => {
  it("defaults parse and follow the owner's table", () => {
    expect(ReviewPolicySchema.parse(DEFAULT_REVIEW_POLICY)).toEqual(DEFAULT_REVIEW_POLICY);
    expect(ruleFor(DEFAULT_REVIEW_POLICY, null)).toEqual({ planApprover: "ceo", reviewer: "senior-dev", ownerSignoff: false });
    // BOS-824: a security review (the CEO until the owner names one) on high and critical work only.
    expect(ruleFor(DEFAULT_REVIEW_POLICY, "critical")).toEqual({ planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true, kinds: { security: "ceo" } });
    expect(ruleFor(DEFAULT_REVIEW_POLICY, "high").kinds).toEqual({ security: "ceo" });
    for (const t of ["trivial", "low", "medium"] as const) expect(DEFAULT_REVIEW_POLICY[t].kinds).toBeUndefined();
  });
  it("rejects nonsense and lists named agents", () => {
    expect(ReviewPolicySchema.safeParse({ ...DEFAULT_REVIEW_POLICY, low: { ...DEFAULT_REVIEW_POLICY.low, reviewer: "owner" } }).success).toBe(false);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(policyAgentIds({ ...DEFAULT_REVIEW_POLICY, low: { ...DEFAULT_REVIEW_POLICY.low, reviewer: id } })).toEqual([id]);
  });
});

// BOS-198: several agents per reviewer cell, and the read-only "who reviews what" line.
describe("reviewer lists", () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const withMedium = (patch: Partial<ReviewRule>) => ({ ...DEFAULT_REVIEW_POLICY, medium: { ...DEFAULT_REVIEW_POLICY.medium, ...patch } });
  it("accepts agent lists in every reviewer cell, but not duplicates, empties or symbols mixed in", () => {
    expect(ReviewPolicySchema.safeParse(withMedium({ reviewer: [a, b], kinds: { security: [a], infra: [a, b], adversarial: b } })).success).toBe(true);
    expect(ReviewPolicySchema.safeParse(withMedium({ reviewer: [a, a] })).success).toBe(false);
    expect(ReviewPolicySchema.safeParse(withMedium({ reviewer: [] })).success).toBe(false);
    expect(ReviewPolicySchema.safeParse(withMedium({ kinds: { security: [a, "ceo"] } })).success).toBe(false);
    expect(ReviewPolicySchema.safeParse(withMedium({ planApprover: [a] as unknown as string })).success).toBe(false);
    expect(policyAgentIds(withMedium({ reviewer: [a, b], kinds: { security: [a] } })).sort()).toEqual([a, b]);
  });
  it("says which reviews an agent does, and at which levels", () => {
    const p = { ...DEFAULT_REVIEW_POLICY, high: { ...DEFAULT_REVIEW_POLICY.high, kinds: { security: [a, b] } }, critical: { ...DEFAULT_REVIEW_POLICY.critical, kinds: { security: a } } };
    expect(describeRoles(reviewRolesOf(p, a))).toBe("Security (High+)");
    expect(describeRoles(reviewRolesOf(p, a, true))).toBe("Code (Medium+), Security (High+)");
    expect(describeRoles(reviewRolesOf({ ...p, low: { ...p.low, kinds: { infra: a } }, critical: { ...p.critical, kinds: { infra: a } } }, a))).toBe("Security (High), Infra (Low, Critical)");
    const all = Object.fromEntries(Object.entries(DEFAULT_REVIEW_POLICY).map(([t, r]) => [t, { ...r, reviewer: [b, a] }])) as typeof DEFAULT_REVIEW_POLICY;
    expect(describeRoles(reviewRolesOf(all, a))).toBe("Code (all levels)");
    expect(describeRoles(reviewRolesOf(DEFAULT_REVIEW_POLICY, a))).toBe("none");
  });
  it("replaces a legacy marked cell with the marked agent, a list, or the CEO", () => {
    const rule = { ...DEFAULT_REVIEW_POLICY.medium, kinds: { security: "marked", infra: "marked", adversarial: "marked" } };
    expect(normaliseMarked(rule, { security: [a], infra: [a, b] }).kinds).toEqual({ security: a, infra: [a, b], adversarial: "ceo" });
    expect(normaliseMarked(DEFAULT_REVIEW_POLICY.low, {})).toBe(DEFAULT_REVIEW_POLICY.low);
  });

  it("keeps the default's owner sign-offs and plan approvals on, and nothing else (BOS-754)", () => {
    const agent = "11111111-1111-4111-8111-111111111111";
    const loose: ReviewPolicy = {
      ...DEFAULT_REVIEW_POLICY,
      low: { planApprover: "owner", reviewer: agent, ownerSignoff: true },
      high: { planApprover: "none", reviewer: agent, ownerSignoff: false, kinds: { security: agent } },
      critical: { ...DEFAULT_REVIEW_POLICY.critical, planApprover: "ceo" },
    };
    const r = noLooserThan(loose);
    // Tightened only where the default has the owner; reviewers, kinds and a stricter low tier are kept.
    expect(r.policy).toEqual({ ...loose, high: { planApprover: "owner", reviewer: agent, ownerSignoff: true, kinds: { security: agent } }, critical: DEFAULT_REVIEW_POLICY.critical });
    expect(r.tightened).toEqual(["your sign-off on high-risk work", "your approval of high-risk plans", "your approval of critical-risk plans"]);
    expect(loose.high.ownerSignoff).toBe(false);
    expect(noLooserThan(DEFAULT_REVIEW_POLICY)).toEqual({ policy: DEFAULT_REVIEW_POLICY, tightened: [] });
  });
});
