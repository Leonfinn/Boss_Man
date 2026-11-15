// BOS-1586: one rule for "a failing check" (the This host panel and the close gate) and the fact clause on criteria.
import { describe, expect, it } from "vitest";
import { afterMergeLint, allowsCardInstead, evalFactClause, factClauses, failingChecks, isFailingCheck, namesHostFact } from "../src/index.js";

describe("isFailingCheck", () => {
  it("counts non-zero trouble counters and a probe or health that isn't ok", () => {
    expect(isFailingCheck("check.container_status.notRunning", "1")).toBe(true);
    expect(isFailingCheck("check.container_status.notRunning", "0")).toBe(false);
    expect(isFailingCheck("check.repo.probe", "failed")).toBe(true);
    expect(isFailingCheck("check.repo.probe", "ok")).toBe(false);
    expect(isFailingCheck("check.server.health", "Healthy")).toBe(false);
  });
  it("ignores missing values and facts outside check.*", () => {
    expect(isFailingCheck("check.repo.probe", "  ")).toBe(false);
    expect(isFailingCheck("repo.probe", "failed")).toBe(false);
    expect(failingChecks({ "check.repo.probe": { value: "failed" }, "check.x.stale": { value: "0" } })).toEqual(["check.repo.probe"]);
  });
});

describe("fact clauses", () => {
  it("reads both forms and skips unreadable ones", () => {
    expect(factClauses("Panel is green (fact: no failing check)")).toEqual([{ kind: "no-failing-check" }]);
    expect(factClauses("Probe ok (fact: repo.probe = ok)")).toEqual([{ kind: "equals", key: "repo.probe", value: "ok" }]);
    expect(factClauses("Nothing here (fact: ???)")).toEqual([]);
    expect(factClauses("No clause")).toEqual([]);
  });
  it("evaluates against the reported facts and names the value seen", () => {
    const facts = { "repo.probe": { value: "failed" }, "check.repo.probe": { value: "failed" } };
    expect(evalFactClause({ kind: "equals", key: "repo.probe", value: "ok" }, facts)).toEqual({ met: false, seen: "repo.probe = failed" });
    expect(evalFactClause({ kind: "equals", key: "repo.nope", value: "ok" }, facts).seen).toContain("not reported");
    expect(evalFactClause({ kind: "no-failing-check" }, facts)).toEqual({ met: false, seen: "check.repo.probe = failed" });
    expect(evalFactClause({ kind: "no-failing-check" }, {}).met).toBe(true);
  });
});

describe("afterMergeLint for host facts", () => {
  const warn = (text: string) => afterMergeLint([{ text, after: "merge" }]);
  it("warns on a host-fact criterion without a clause, and stays quiet with one", () => {
    expect(warn("The This host panel shows no failing check")).toMatch(/fact clause/);
    expect(warn("repo.probe is ok on the host")).toMatch(/fact clause/);
    expect(warn("The This host panel shows no failing check (fact: no failing check)")).toBe("");
    expect(warn("A push arrives on the owner's phone")).toBe("");
    expect(afterMergeLint(["The This host panel shows no failing check"])).toBe("");
  });
  it("names host facts and card escapes", () => {
    expect(namesHostFact("shows This host")).toBe(true);
    expect(allowsCardInstead("no failing check, or names one with a card raised for it")).toBe(true);
    expect(allowsCardInstead("no failing check (fact: no failing check)")).toBe(false);
  });
});
