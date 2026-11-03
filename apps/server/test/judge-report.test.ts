import { describe, expect, it } from "vitest";
import { summarise, formatReport } from "../src/services/judge-report.js";

const card = (answer: string, verdict: string, row: string, second?: string, settled?: boolean) => ({ answer, context: { judge: { verdict, row, ...(second ? { second: { state: second } } : {}) }, ...(settled ? { settled: {} } : {}) } });

describe("judge agreement report", () => {
  it("counts agreement, false allows by band, and the second opinion", () => {
    const rows = [
      card("Allow once", "allow", "ok", "allow", true),
      card("Deny", "allow", "ok"),
      card("Deny", "allow", "opaque"),
      card("Deny", "deny", "secret"),
      card("Allow once", "allow", "ok", "deny"),
      card("Keep planning", "allow", "ok"),
      { answer: "Allow once", context: {} },
    ];
    const r = summarise(rows, new Date("2026-11-01"), new Date("2026-11-15"));
    expect(r.judged).toBe(6);
    expect(r.unclassified).toBe(1);
    expect(r.agreement).toEqual({ agreed: 3, compared: 5, pct: 60 });
    expect(r.agreementRulesOnly.agreed).toBe(4 - 1); // allow/allow, deny/deny, allow/allow(second deny): rules say allow=human allow
    expect(r.falseAllows.band).toEqual({ A: 1, B: 1 });
    expect(r.falseAllows.total).toBe(2);
    expect(r.second).toMatchObject({ asked: 2, allow: 1, deny: 1, denyHumanAllowed: 1 });
    expect(r.answeredBy).toEqual({ ceo: 1, owner: 4 });
    expect(formatReport(r)).toContain("band A 1, band B 1");
  });
  it("reports n/a with no cards", () => {
    expect(summarise([], new Date(), new Date()).agreement.pct).toBeNull();
  });
});
