import { describe, expect, it } from "vitest";
import { rulesCsv, rulesCsvName } from "../src/pages/Rules";

const agents: any[] = [{ id: "a1", name: "Kit" }, { id: "a2", name: "Zippy" }];
const rules: any[] = [
  { id: "r1", companyId: "c1", name: "Restarts, fine", match: { commandPattern: "^docker restart", kinds: ["execute", "other"] }, outcome: "allow", position: 0 },
  { id: "r2", companyId: "c1", name: "=Evil", match: { agentIds: ["a1", "a2"], titlePattern: "^mcp__" }, outcome: "owner", position: 1, expiresAt: "2026-12-01T10:00:00.000Z" },
];
const c = (n: number) => ({ allow: n, ceo: 0, owner: 0, deny: 0 });
const usage = { "Restarts, fine": { week: c(2), month: c(9), lastAt: "2026-11-22T08:00:00.000Z" } };
const head = "name,command_pattern,title_pattern,outcome,applies_to,kinds,expires_at,uses_7_days,uses_30_days,last_matched_at";

describe("rulesCsv", () => {
  it("writes one row per rule, in order, with usage", () => {
    const lines = rulesCsv(rules, agents, usage).split("\r\n");
    expect(lines[0]).toBe(head);
    expect(lines[1]).toBe(`"Restarts, fine",^docker restart,,allow,everyone,execute; other,,2,9,2026-11-22T08:00:00.000Z`);
    expect(lines[2]).toBe(`'=Evil,,^mcp__,owner,Kit; Zippy,,2026-12-01T10:00:00.000Z,0,0,`);
  });

  it("leaves usage blank until it has loaded", () => {
    expect(rulesCsv(rules, agents, undefined).split("\r\n")[1]).toBe(`"Restarts, fine",^docker restart,,allow,everyone,execute; other,,,,`);
  });

  it("names the file by scope and day", () => {
    expect(rulesCsvName("App Co", new Date("2026-11-24T10:00:00Z"))).toBe("permission-rules-app-co-2026-11-24.csv");
    expect(rulesCsvName("all", new Date("2026-11-24T10:00:00Z"))).toBe("permission-rules-all-2026-11-24.csv");
  });
});
