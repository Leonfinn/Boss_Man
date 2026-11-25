import { describe, expect, it } from "vitest";
import type { Agent } from "../src/api";
import { agoText, literalTitlePattern, ruleMatchesFilter } from "../src/pages/Rules";

const agents = [
  { id: "a1", name: "Kit" },
  { id: "a2", name: "Zippy" },
] as Agent[];

const rule = (over: Partial<{ name: string; match: any; outcome: "allow" | "ceo" | "owner" | "deny" }> = {}) => ({
  name: "Restarts, fine",
  match: {} as any,
  outcome: "allow" as const,
  ...over,
});

describe("agoText", () => {
  const now = new Date("2026-11-25T12:00:00Z");

  it("says today for a time earlier the same day", () => {
    expect(agoText("2026-11-25T01:00:00Z", now)).toBe("today");
  });

  it("says yesterday for one day before", () => {
    expect(agoText("2026-11-24T12:00:00Z", now)).toBe("yesterday");
  });

  it("counts whole days", () => {
    expect(agoText("2026-11-20T12:00:00Z", now)).toBe("5 days ago");
  });

  it("treats a time in the future as today, not a negative age", () => {
    expect(agoText("2026-11-26T12:00:00Z", now)).toBe("today");
  });
});

describe("ruleMatchesFilter", () => {
  it("drops a rule whose outcome differs from the filter", () => {
    expect(ruleMatchesFilter(rule({ outcome: "allow" }), { text: "", outcome: "deny" })).toBe(false);
  });

  it("keeps every rule when the text is empty or only blanks", () => {
    expect(ruleMatchesFilter(rule(), { text: "", outcome: "" })).toBe(true);
    expect(ruleMatchesFilter(rule(), { text: "   ", outcome: "" })).toBe(true);
  });

  it("matches the rule name, command pattern, title pattern or an agent's name", () => {
    const r = rule({ name: "Restarts, fine", match: { commandPattern: "^docker restart", titlePattern: "^Deploy\\.sh$", agentIds: ["a1"] } });
    for (const text of ["restarts", "DOCKER", "deploy", "kit"]) {
      expect(ruleMatchesFilter(r, { text, outcome: "" }, agents), text).toBe(true);
    }
  });

  it("is case-insensitive both ways round", () => {
    expect(ruleMatchesFilter(rule({ name: "Kit's rule" }), { text: "kIt'S", outcome: "" })).toBe(true);
  });

  it("drops a rule whose text matches none of its fields", () => {
    expect(ruleMatchesFilter(rule({ match: { commandPattern: "^docker restart" } }), { text: "ls", outcome: "" })).toBe(false);
  });

  it("does not throw when an agent id is not in the list", () => {
    const r = rule({ match: { agentIds: ["gone"] } });
    expect(() => ruleMatchesFilter(r, { text: "kit", outcome: "" }, agents)).not.toThrow();
    expect(ruleMatchesFilter(r, { text: "kit", outcome: "" }, agents)).toBe(false);
  });
});

describe("literalTitlePattern", () => {
  it("wraps a plain title in ^ and $", () => {
    expect(literalTitlePattern("Deploy")).toBe("^Deploy$");
  });

  it("escapes regex characters so the pattern matches only that exact title", () => {
    const title = "a.b[c]+d?";
    const pattern = literalTitlePattern(title);
    expect(new RegExp(pattern).test(title)).toBe(true);
    expect(new RegExp(pattern).test("aXb[c]+d?")).toBe(false);
    expect(new RegExp(pattern).test(`${title} more`)).toBe(false);
  });
});
