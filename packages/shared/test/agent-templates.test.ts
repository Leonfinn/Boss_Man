import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES, CEO_TEMPLATE, agentIdentity } from "../src/agent-templates.js";

// Tool names templates may mention: the registerTool names in apps/server/src/mcp.ts.
const TOOLS = new Set([
  "assign_ticket", "board", "clear_check", "create_ticket", "decisions", "deploy", "engagement", "feedback", "features", "handoff", "link_tickets", "list_my_work", "log_feedback",
  "model_options", "notify_owner", "nudge", "pa_escalate", "pa_reply", "pa_verdict", "propose_hire", "propose_model_change", "propose_team", "raise_decision", "report_key_result", "request_engagement", "review", "runs", "schedule_check",
  "set_milestone", "set_ticket_risk", "set_ticket_state", "skills", "ticket_reply", "tickets", "update_instructions", "update_ticket", "whats_new", "wiki",
]);
const ALL = [...AGENT_TEMPLATES, { ...CEO_TEMPLATE, role: "manager" as const }];

describe("templates", () => {
  it("has the four review and infra roles, as most-capable workers with no standing duty", () => {
    const want = { "senior-dev": "Senior Developer", "security-reviewer": "Security Reviewer", "adversarial-reviewer": "Adversarial Reviewer", "senior-infra": "Senior Infrastructure Engineer" };
    for (const [id, title] of Object.entries(want)) {
      const t = AGENT_TEMPLATES.find((x) => x.id === id)!;
      expect(t).toMatchObject({ title, role: "worker", modelTier: "most capable" });
      expect(t.duty).toBeUndefined();
    }
  });

  it("has the four added roles with the intended tiers", () => {
    const want = { "product-manager": ["Product Manager", "balanced"], "release-manager": ["Release Manager", "fast"], "data-analytics": ["Data & Analytics", "balanced"], support: ["Support", "fast"] };
    for (const [id, [title, modelTier]] of Object.entries(want)) expect(AGENT_TEMPLATES.find((x) => x.id === id)).toMatchObject({ title, modelTier, role: "worker" });
    expect(AGENT_TEMPLATES.filter((t) => t.duty).map((t) => t.id)).toEqual(["assistant"]);
  });

  it.each(ALL.map((t) => [t.id, t] as const))("%s is well formed", (_id, t) => {
    expect(t.id && t.title).toBeTruthy();
    expect(["most capable", "balanced", "fast"]).toContain(t.modelTier);
    expect(t.summary.trim().split(/(?<=[.!?])\s+/).length).toBe(1); // one sentence
    expect(t.instructions.length).toBeGreaterThan(100);
    expect(t.instructions.length).toBeLessThan(3000);
  });

  it("does not repeat text Boss Man already adds to every prompt", () => {
    for (const t of ALL) {
      expect(t.instructions).not.toContain("Details:");
      expect(t.instructions).not.toContain("loose file");
    }
  });

  it("names only tools that exist", () => {
    for (const t of ALL) {
      const named = t.instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
      for (const w of named) expect(TOOLS, `${t.id} mentions ${w}`).toContain(w);
    }
  });
});

const base = { name: "Ada", role: "worker", title: null, instructions: "Do the thing." } as const;

describe("agentIdentity", () => {
  it("introduces a CEO by role, ignoring any title", () => {
    expect(agentIdentity({ ...base, role: "ceo", title: "Chief" }, "Acme").who).toBe("Ada, the CEO of Acme");
  });

  it("uses the title of a titled agent", () => {
    expect(agentIdentity({ ...base, title: "Engineer" }, "Acme").who).toBe("Ada, the Engineer of Acme");
  });

  it("uses the role when the agent has no title", () => {
    expect(agentIdentity({ ...base, title: null }, "Acme").who).toBe("Ada, the worker of Acme");
  });

  it.each([null, "", "   ", "\n\t "])("has no instruction lines when instructions are %j", (instructions) => {
    expect(agentIdentity({ ...base, instructions }, "Acme").instructions).toEqual([]);
  });

  it("keeps the instructions, trimmed, between a heading and the model setup", () => {
    expect(agentIdentity({ ...base, instructions: "  Do the thing.\n" }, "Acme").instructions).toEqual([
      "",
      "Your instructions from the owner:",
      "Do the thing.",
      "",
      "Your model is set in Boss Man: your agent's default. If anything in your instructions names a different model, this setting is the right one.",
    ]);
  });

  it("names the model and the thinking level when both are set", () => {
    const { instructions } = agentIdentity({ ...base, model: "infinite:small", thinking: "high" }, "Acme");
    expect(instructions.at(-1)).toBe(
      "Your model is set in Boss Man: infinite:small, with high thinking. If anything in your instructions names a different model, this setting is the right one.",
    );
  });

  it("falls back to the agent's default model when none is set", () => {
    const { instructions } = agentIdentity({ ...base, model: null, thinking: "high" }, "Acme");
    expect(instructions.at(-1)).toBe(
      "Your model is set in Boss Man: your agent's default, with high thinking. If anything in your instructions names a different model, this setting is the right one.",
    );
  });
});
