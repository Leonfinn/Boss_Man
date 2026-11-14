import { describe, expect, it } from "vitest";
import { agentIdentity } from "../src/agent-templates.js";

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
