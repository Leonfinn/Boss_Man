import { describe, expect, it } from "vitest";
import { commandProblem, parseStep, sh, step, whereFence } from "../src/services/steps.js";

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

describe("where a command runs (BOS-427)", () => {
  it("writes the host and account on the fence line, not in what the owner pastes", () => {
    const t = step("List the backups:", sh("ls -l /mnt/backups", { host: "nas01", as: "root" }));
    expect(t).toBe("List the backups:\n\n```sh host=\"nas01\" as=\"root\"\nls -l /mnt/backups\n```");
    expect(parseStep(t)).toEqual([
      { type: "text", text: "List the backups:" },
      { type: "command", text: "ls -l /mnt/backups", where: { host: "nas01", as: "root" } },
    ]);
  });

  it("reads as=login too", () => {
    expect(parseStep(step("Check:", sh("id", { host: "nas01", as: "login" })))[1]).toEqual({ type: "command", text: "id", where: { host: "nas01", as: "login" } });
  });

  it("refuses a host name that isn't a plain name, and an account that isn't root or login", () => {
    expect(() => whereFence({ host: "nas 01", as: "root" })).toThrow(/plain name/);
    expect(() => whereFence({ host: "<host>", as: "root" })).toThrow(/plain name/);
    expect(() => whereFence({ host: "nas01", as: "admin" as "root" })).toThrow(/root or login/);
  });

  it("a fence line that isn't the expected form carries no host (so R6 refuses it rather than guessing)", () => {
    expect(parseStep("```sh host=nas01\nls\n```")).toEqual([{ type: "command", text: "ls" }]);
  });
});
