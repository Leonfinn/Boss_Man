import { describe, expect, it } from "vitest";
import { modelChoices } from "../src/session-manager.js";

describe("model choices from an ACP session (R60)", () => {
  it("reads the model option's choices, flat or grouped, and ignores other options", () => {
    const flat = [
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "plan", name: "Plan" }] },
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: [{ value: "default", name: "Default", description: "Recommended" }, { value: "opus", name: "Opus" }] },
    ];
    expect(modelChoices(flat)).toEqual([
      { value: "default", name: "Default", description: "Recommended" },
      { value: "opus", name: "Opus", description: null },
    ]);
    const grouped = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-5", options: [{ group: "openai", name: "OpenAI", options: [{ value: "gpt-5", name: "GPT-5" }] }] }];
    expect(modelChoices(grouped)).toEqual([{ value: "gpt-5", name: "GPT-5", description: null }]);
    expect(modelChoices(null)).toEqual([]);
    expect(modelChoices([{ id: "x", category: "model", type: "boolean", currentValue: true }])).toEqual([]);
  });
});
