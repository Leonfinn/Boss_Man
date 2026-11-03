import { describe, expect, it } from "vitest";
import { summarise, formatReport } from "../src/services/judge-report.js";

const card = (answer: string, verdict: string, row: string, second?: string, settled?: boolean, command?: string) => ({ answer, context: { ...(command ? { explain: { title: "x wants to run a command", summary: "Runs it.", command } } : {}), judge: { verdict, row, ...(second ? { second: { state: second } } : {}) }, ...(settled ? { settled: {} } : {}) } });

describe("judge agreement report", () => {
  it("counts agreement, false allows by band, and the second opinion", () => {
    const rows = [
      card("Allow once", "allow", "ok", "allow", true),
      card("Deny", "allow", "ok", undefined, false, "ls /tmp"),
      card("Deny", "allow", "ok", undefined, false, "git push origin HEAD:main"),
      card("Deny", "allow", "ok"),
      card("Deny", "deny", "secret"),
      card("Allow once", "allow", "ok", "deny"),
      card("Keep planning", "allow", "ok"),
      { answer: "Allow once", context: {} },
    ];
    const r = summarise(rows, new Date("2026-11-01"), new Date("2026-11-15"));
    expect(r.judged).toBe(7);
    expect(r.unclassified).toBe(1);
    expect(r.agreement).toEqual({ agreed: 2, compared: 6, pct: 33.3 });
    expect(r.agreementRulesOnly.agreed).toBe(3);
    expect(r.falseAllows.band).toEqual({ A: 1, B: 1, unknown: 1 });
    expect(r.falseAllows.total).toBe(3);
    expect(r.second).toMatchObject({ asked: 2, allow: 1, deny: 1, denyHumanAllowed: 1 });
    expect(r.answeredBy).toEqual({ ceo: 1, owner: 5 });
    expect(formatReport(r)).toContain("band A 1, band B 1, band unknown 1");
  });
  it("reports n/a with no cards", () => {
    expect(summarise([], new Date(), new Date()).agreement.pct).toBeNull();
  });
});
