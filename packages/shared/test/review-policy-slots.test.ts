import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_POLICY, MARKED, normaliseMarked, normalisePolicyMarked, ReviewPolicySchema, slotRef, type ReviewPolicy, type ReviewRule } from "../src/review-policy.js";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";

const rule = (patch: Partial<ReviewRule> = {}): ReviewRule => ({ planApprover: "ceo", reviewer: "ceo", ownerSignoff: false, ...patch });

describe("slotRef", () => {
  it("reads the code reviewer from the rule itself, whatever shape it holds", () => {
    expect(slotRef(rule({ reviewer: "senior-dev" }), "code")).toBe("senior-dev");
    expect(slotRef(rule(), "code")).toBe("ceo");
    expect(slotRef(rule({ reviewer: a }), "code")).toBe(a);
    expect(slotRef(rule({ reviewer: [a, b] }), "code")).toEqual([a, b]);
  });

  it("reads an extra kind from the rule's kinds, and is undefined when the kind is off", () => {
    expect(slotRef(DEFAULT_REVIEW_POLICY.high, "security")).toBe("ceo");
    expect(slotRef(DEFAULT_REVIEW_POLICY.high, "infra")).toBeUndefined();
    expect(slotRef(DEFAULT_REVIEW_POLICY.high, "adversarial")).toBeUndefined();
    const extra = rule({ kinds: { security: a, infra: [a, b] } });
    expect(slotRef(extra, "security")).toBe(a);
    expect(slotRef(extra, "infra")).toEqual([a, b]);
    expect(slotRef(extra, "adversarial")).toBeUndefined();
    // A legacy "marked" cell is still a ref: normaliseMarked resolves it later.
    expect(slotRef(rule({ kinds: { security: MARKED } }), "security")).toBe(MARKED);
  });
});

describe("normaliseMarked", () => {
  it("returns the very same rule when nothing is marked", () => {
    const noKinds = rule();
    expect(normaliseMarked(noKinds, { security: [a] })).toBe(noKinds);
    const plainKinds = rule({ kinds: { security: a } });
    expect(normaliseMarked(plainKinds, { security: [a] })).toBe(plainKinds);
    const emptyKinds = rule({ kinds: {} });
    expect(normaliseMarked(emptyKinds, {})).toBe(emptyKinds);
  });

  it("replaces a marked kind with its one marked agent, a list, or the CEO when none is marked", () => {
    expect(normaliseMarked(rule({ kinds: { security: MARKED } }), { security: [a] }).kinds).toEqual({ security: a });
    expect(normaliseMarked(rule({ kinds: { security: MARKED } }), { security: [a, b] }).kinds).toEqual({ security: [a, b] });
    expect(normaliseMarked(rule({ kinds: { security: MARKED } }), { security: [] }).kinds).toEqual({ security: "ceo" });
    expect(normaliseMarked(rule({ kinds: { security: MARKED } }), {}).kinds).toEqual({ security: "ceo" });
  });

  it("leaves the other kinds as they were and does not change the input", () => {
    const before = rule({ kinds: { security: MARKED, infra: a } });
    const out = normaliseMarked(before, { security: [b] });
    expect(out.kinds).toEqual({ security: b, infra: a });
    expect(before.kinds).toEqual({ security: MARKED, infra: a });
    expect(out).not.toBe(before);
  });
});

describe("normalisePolicyMarked", () => {
  it("normalises every tier that has a marked cell and leaves the others alone", () => {
    const policy: ReviewPolicy = {
      ...DEFAULT_REVIEW_POLICY,
      medium: { ...DEFAULT_REVIEW_POLICY.medium, kinds: { security: MARKED } },
      high: { ...DEFAULT_REVIEW_POLICY.high, kinds: { security: MARKED, infra: a } },
      critical: { ...DEFAULT_REVIEW_POLICY.critical, kinds: { security: MARKED, adversarial: MARKED } },
    };
    const out = normalisePolicyMarked(policy, { security: [a], adversarial: [a, b] });
    expect(out.medium.kinds).toEqual({ security: a });
    expect(out.high.kinds).toEqual({ security: a, infra: a });
    expect(out.critical.kinds).toEqual({ security: a, adversarial: [a, b] });
    // The tiers with no marked cell are untouched, and the result is still a valid policy.
    expect(out.trivial).toBe(policy.trivial);
    expect(out.low).toBe(policy.low);
    expect(ReviewPolicySchema.safeParse(out).success).toBe(true);
    // The input policy is left as it was.
    expect(policy.medium.kinds).toEqual({ security: MARKED });
  });

  it("returns every tier, and puts the CEO on a marked cell whose marks are missing", () => {
    const marked = (tier: keyof ReviewPolicy): ReviewRule => ({ ...DEFAULT_REVIEW_POLICY[tier], kinds: { security: MARKED } });
    const policy: ReviewPolicy = {
      trivial: marked("trivial"),
      low: marked("low"),
      medium: marked("medium"),
      high: marked("high"),
      critical: marked("critical"),
    };
    const out = normalisePolicyMarked(policy, {});
    for (const tier of ["trivial", "low", "medium", "high", "critical"] as const) expect(out[tier].kinds).toEqual({ security: "ceo" });
  });
});
