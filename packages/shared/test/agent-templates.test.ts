import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES } from "../src/agent-templates.js";

describe("senior templates", () => {
  it("has the four review and infra roles, as most-capable workers with no standing duty", () => {
    const want = { "senior-dev": "Senior Developer", "security-reviewer": "Security Reviewer", "adversarial-reviewer": "Adversarial Reviewer", "senior-infra": "Senior Infrastructure Engineer" };
    for (const [id, title] of Object.entries(want)) {
      const t = AGENT_TEMPLATES.find((x) => x.id === id)!;
      expect(t).toMatchObject({ title, role: "worker", modelTier: "most capable" });
      expect(t.duty).toBeUndefined();
      expect(t.summary.length).toBeGreaterThan(10);
      expect(t.instructions.length).toBeGreaterThan(100);
    }
  });
});
