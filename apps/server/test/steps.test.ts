import { describe, expect, it } from "vitest";
import { commandProblem, parseStep, sh, step } from "../src/services/steps.js";

describe("copy-safe owner steps (BOS-269)", () => {
  it("puts each command in its own block under the sentence", () => {
    const t = step("Run this:", sh("ls -l"), "Then this:", sh("pwd"));
    expect(t).toBe("Run this:\n\n```sh\nls -l\n```\n\nThen this:\n\n```sh\npwd\n```");
    expect(parseStep(t)).toEqual([
      { type: "text", text: "Run this:" },
      { type: "command", text: "ls -l" },
      { type: "text", text: "Then this:" },
      { type: "command", text: "pwd" },
    ]);
  });

  it("leaves a step without commands as plain text", () => {
    expect(step("Open Settings.")).toBe("Open Settings.");
    expect(parseStep("Open Settings.")).toEqual([{ type: "text", text: "Open Settings." }]);
  });

  it.each([
    ["$ ls", "prompt"],
    ["ls.", "punctuation"],
    ["ls,", "punctuation"],
    ["docker compose kill server-<colour>", "placeholder"],
    ["ls\npwd", "line"],
    [" ls", "spaces"],
    ["", "empty"],
  ])("refuses %j", (cmd) => {
    expect(commandProblem(cmd)).not.toBeNull();
    expect(() => step("x", sh(cmd))).toThrow(/copy-safe/);
  });

  it("accepts a command with quotes, arrows and redirections", () => {
    expect(commandProblem(`docker exec x node -e "fetch('u').then(async r=>console.log(await r.text()))"`)).toBeNull();
    expect(commandProblem("cat a > b")).toBeNull();
  });
});
