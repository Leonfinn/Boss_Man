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

  it("keeps the floor's review kinds and non-CEO reviewers, and anything the policy adds (BOS-818)", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    // A floor with a security review at high (as a package's company policy may have).
    const floor: ReviewPolicy = { ...DEFAULT_REVIEW_POLICY, high: { ...DEFAULT_REVIEW_POLICY.high, kinds: { security: [a, b] } } };
    const loose: ReviewPolicy = {
      ...DEFAULT_REVIEW_POLICY,
      medium: { ...DEFAULT_REVIEW_POLICY.medium, reviewer: "ceo" },
      high: { ...DEFAULT_REVIEW_POLICY.high, kinds: { infra: a } },
      critical: { ...DEFAULT_REVIEW_POLICY.critical, reviewer: b, kinds: { ...DEFAULT_REVIEW_POLICY.critical.kinds, adversarial: "ceo" } },
    };
    const r = noLooserThan(loose, floor);
    expect(r.policy).toEqual({
      ...loose,
      medium: DEFAULT_REVIEW_POLICY.medium,
      high: { ...DEFAULT_REVIEW_POLICY.high, kinds: { infra: a, security: [a, b] } },
    });
    expect(r.tightened).toEqual(["a reviewer other than the CEO for medium-risk work", "the security review of high-risk work"]);
    // A kind the policy already has keeps its own reviewer; the default floor adds its security review (BOS-824).
    expect(noLooserThan({ ...floor, high: { ...floor.high, kinds: { security: "ceo" } } }, floor).tightened).toEqual([]);
    expect(noLooserThan(loose).policy.high.kinds).toEqual({ infra: a, security: "ceo" });
    expect(loose.medium.reviewer).toBe("ceo");
  });

  it("restores the floor's reviewer and kinds at every tier, not just one, and is stable when run twice (BOS-818)", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const kindsAll = { security: a, infra: a, adversarial: "ceo" as const };
    const withKinds = (tier: "medium" | "high" | "critical"): ReviewPolicy["high"] => ({ ...DEFAULT_REVIEW_POLICY[tier], kinds: kindsAll });
    const floor: ReviewPolicy = { ...DEFAULT_REVIEW_POLICY, medium: withKinds("medium"), high: withKinds("high"), critical: withKinds("critical") };
    // Every tier handed to the CEO with no kinds at all.
    const bare: ReviewPolicy = {
      trivial: DEFAULT_REVIEW_POLICY.trivial,
      low: DEFAULT_REVIEW_POLICY.low,
      medium: { ...DEFAULT_REVIEW_POLICY.medium, reviewer: "ceo" },
      high: { ...DEFAULT_REVIEW_POLICY.high, reviewer: "ceo" },
      critical: { ...DEFAULT_REVIEW_POLICY.critical, reviewer: "ceo" },
    };
    const r = noLooserThan(bare, floor);
    for (const tier of ["medium", "high", "critical"] as const) {
      expect(r.policy[tier].reviewer).toBe(DEFAULT_REVIEW_POLICY[tier].reviewer);
      expect(r.policy[tier].kinds).toEqual(kindsAll);
    }
    // Trivial and low: the floor has the CEO there, so nothing is added or swapped.
    expect(r.policy.trivial).toEqual(DEFAULT_REVIEW_POLICY.trivial);
    expect(r.policy.low).toEqual(DEFAULT_REVIEW_POLICY.low);
    expect(r.tightened.filter((t) => t.startsWith("a reviewer other than the CEO"))).toHaveLength(3);
    expect(r.tightened.filter((t) => t.includes("review of"))).toHaveLength(9);
    // Raising an already-raised policy changes nothing and says nothing.
    expect(noLooserThan(r.policy, floor)).toEqual({ policy: r.policy, tightened: [] });
    // The result still parses as a policy.
    expect(ReviewPolicySchema.safeParse(r.policy).success).toBe(true);
  });
});
