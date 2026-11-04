import { describe, expect, it } from "vitest";
import { evaluatePermission } from "@boss-man/shared";
import { createPermissionLog } from "../src/services/permission-log.js";

const base = { companyId: "c1", runId: "r1", agentId: "a1", ticketId: "t1", title: "Bash: ls", kind: "execute" };

describe("permission log", () => {
  it("writes one searchable line per decision with run, agent and ticket ids", () => {
    const lines: string[] = [];
    const p = createPermissionLog({ log: (l) => lines.push(l) });
    p.decision({ ...base, rule: "Read-only shell", position: 3, outcome: "allow", tier: "allow" });
    p.decision({ ...base, rule: "Anything else", position: 9, outcome: "ceo", tier: "ceo", decisionId: "d1" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("run=r1");
    expect(lines[0]).toContain("agent=a1");
    expect(lines[0]).toContain("ticket=t1");
    expect(lines[0]).toContain('rule="Read-only shell"');
    expect(lines[0]).toContain("position=3");
    expect(lines[1]).toContain("card=d1");
  });

  it("summarises rule matches, cards reached and answers for one company", () => {
    const p = createPermissionLog();
    p.decision({ ...base, rule: "A", position: 1, outcome: "allow", tier: "allow" });
    p.decision({ ...base, rule: "A", position: 1, outcome: "allow", tier: "allow" });
    p.decision({ ...base, rule: "B", position: 2, outcome: "ceo", tier: "ceo", decisionId: "d1" });
    p.decision({ ...base, rule: "B", position: 2, outcome: "ceo", tier: "owner", decisionId: "d2" });
    p.decision({ ...base, companyId: "other", rule: "A", position: 1, outcome: "allow", tier: "allow" });
    p.answer({ companyId: "c1", runId: "r1", agentId: "a1", ticketId: "t1", decisionId: "d1", answeredBy: "ceo", answer: "allow" });
    const s = p.summary("c1");
    expect(s.rules[0]).toMatchObject({ rule: "A", position: 1, outcome: "allow", matches: 2 });
    expect(s.rules).toHaveLength(2);
    expect(s.cardsReached).toEqual({ ceo: 1, owner: 1 });
    expect(s.cardsAnswered).toEqual({ ceo: 1, owner: 0 });
  });

  it("forgets entries older than an hour", () => {
    let t = new Date("2026-11-02T09:00:00Z");
    const p = createPermissionLog({ now: () => t });
    p.decision({ ...base, rule: "A", position: 1, outcome: "allow", tier: "allow" });
    t = new Date("2026-11-02T10:01:00Z");
    expect(p.summary("c1").rules).toHaveLength(0);
  });

  it("logs refused tool calls with run, ticket and agent ids", () => {
    const lines: string[] = [];
    const p = createPermissionLog({ log: (l) => lines.push(l) });
    p.refusedCall({ companyId: "c1", runId: "r9", agentId: "a2", ticketId: "t2", title: "Edit foo.ts" });
    expect(lines[0]).toContain("refused tool call");
    expect(lines[0]).toContain("run=r9");
    expect(lines[0]).toContain("ticket=t2");
    expect(lines[0]).toContain("agent=a2");
    const s = p.summary("c1");
    expect(s.refusedCalls.count).toBe(1);
    expect(s.refusedCalls.recent[0]).toMatchObject({ runId: "r9", ticketId: "t2", tool: "Edit foo.ts" });
    expect(p.summary("other").refusedCalls.count).toBe(0);
  });

  it("evaluatePermission reports the deciding rule's position", () => {
    const r = evaluatePermission({ title: "Read x", kind: "read", rawInput: {} }, []);
    expect(typeof r.position).toBe("number");
  });
});
