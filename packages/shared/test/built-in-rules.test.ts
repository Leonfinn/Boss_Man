import { describe, expect, it } from "vitest";
import { BUILT_IN_RULES } from "../src/built-in-rules.js";

// BOS-754 / QA BOS-821. The server tests check that a run's prompt contains these lines, but
// `toContain(rules.join("\n"))` also passes when the list is empty, so the three rules are pinned here.
describe("built-in rules", () => {
  const text = BUILT_IN_RULES.join("\n");

  it("has a heading and the four rules", () => {
    expect(BUILT_IN_RULES).toHaveLength(5);
    expect(BUILT_IN_RULES[0]).toMatch(/built-in rules/i);
    expect(BUILT_IN_RULES.slice(1).every((l) => l.startsWith("- "))).toBe(true);
  });

  it("forbids writing a token, key or password anywhere", () => {
    expect(text).toMatch(/Never write a token, key or password/);
  });

  it("forbids calling the /mcp endpoint by hand and says to stop when the tools are missing", () => {
    expect(text).toMatch(/Never call Boss Man's \/mcp endpoint by hand/);
    expect(text).toMatch(/tools are missing, stop/);
  });

  it("tells the agent to change files with its edit tools, not shell one-liners", () => {
    expect(text).toMatch(/file edit and write tools/);
    expect(text).toMatch(/sed -i/);
  });

  it("tells the agent to run scripts by a literal path or $BOSSMAN_SCRATCH, not a variable it set", () => {
    expect(text).toMatch(/literal path or `\$BOSSMAN_SCRATCH\/…`, never through a variable you set yourself/);
  });

  it("stays short and generic: no company, host or path names", () => {
    expect(text.length).toBeLessThan(1500);
    expect(text).not.toMatch(/\/home\/|\/tmp\/|github\.com|192\.168/);
  });
});
