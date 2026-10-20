import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_POLICY, ReviewPolicySchema, ruleFor, policyAgentIds } from "../src/review-policy.js";

describe("review policy", () => {
  it("defaults parse and follow the owner's table", () => {
    expect(ReviewPolicySchema.parse(DEFAULT_REVIEW_POLICY)).toEqual(DEFAULT_REVIEW_POLICY);
    expect(ruleFor(DEFAULT_REVIEW_POLICY, null)).toEqual({ planApprover: "ceo", reviewer: "senior-dev", ownerSignoff: false });
    expect(ruleFor(DEFAULT_REVIEW_POLICY, "critical")).toEqual({ planApprover: "owner", reviewer: "senior-dev", ownerSignoff: true });
  });
  it("rejects nonsense and lists named agents", () => {
    expect(ReviewPolicySchema.safeParse({ ...DEFAULT_REVIEW_POLICY, low: { ...DEFAULT_REVIEW_POLICY.low, reviewer: "owner" } }).success).toBe(false);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(policyAgentIds({ ...DEFAULT_REVIEW_POLICY, low: { ...DEFAULT_REVIEW_POLICY.low, reviewer: id } })).toEqual([id]);
  });
});
