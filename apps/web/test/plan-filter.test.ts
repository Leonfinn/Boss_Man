// BOS-2430: the Plan page's filters, per-person summary and CSV.
import { describe, expect, it } from "vitest";
import type { Plan, PlanNode } from "../src/api";
import { applyPlanFilter, NO_PLAN_FILTER, parsePlanFilter, personSummary, planFilterQuery, planToCsv, UNASSIGNED } from "../src/plan-filter";

const node = (over: Partial<PlanNode> & { id: string }): PlanNode => ({
  kind: "ticket", ref: null, title: over.id, state: "in_progress", open: true, link: "#", assignee: null, project: null, layer: 0, blocked: false, causes: [], holdingUp: 0, ...over,
});

const plan: Plan = {
  nodes: [
    node({ id: "a", ref: "BOS-1", assignee: "Ann", project: "Web", holdingUp: 2 }),
    node({ id: "b", ref: "BOS-2", assignee: "Bob", project: "Server", blocked: true, causes: ["a"] }),
    node({ id: "c", ref: "BOS-3", assignee: "Bob", project: "Server", blocked: true, causes: ["a"] }),
    node({ id: "d", ref: "BOS-4", assignee: "Ann", project: "Web", open: false, state: "done" }),
    node({ id: "e", kind: "decision", title: "Pick", project: "Web" }),
  ],
  edges: [{ id: "1", from: "a", to: "b" }, { id: "2", from: "a", to: "c" }],
  columns: [["a", "d", "e"], ["b", "c"]],
};

describe("plan filter link", () => {
  it("round-trips through the page link", () => {
    const f = { project: "Web", assignee: "Ann", kind: "ticket" as const, finished: true };
    expect(parsePlanFilter(new URLSearchParams(planFilterQuery(f)))).toEqual(f);
    expect(planFilterQuery(NO_PLAN_FILTER)).toBe("");
    expect(parsePlanFilter(new URLSearchParams("kind=nonsense")).kind).toBe("");
  });
});

describe("applyPlanFilter", () => {
  it("hides finished items by default and shows them on request", () => {
    expect(applyPlanFilter(plan, NO_PLAN_FILTER).shown.map((n) => n.id)).toEqual(["a", "b", "c", "e"]);
    expect(applyPlanFilter(plan, { ...NO_PLAN_FILTER, finished: true }).shown).toHaveLength(5);
  });
  it("keeps a hidden cause, faded, so the wait is explained", () => {
    const v = applyPlanFilter(plan, { ...NO_PLAN_FILTER, assignee: "Bob" });
    expect(v.shown.map((n) => n.id)).toEqual(["b", "c"]);
    expect([...v.faded]).toEqual(["a"]);
    expect(v.plan.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(v.plan.edges).toHaveLength(2);
  });
  it("filters by kind, project and unassigned", () => {
    expect(applyPlanFilter(plan, { ...NO_PLAN_FILTER, kind: "decision" }).shown.map((n) => n.id)).toEqual(["e"]);
    expect(applyPlanFilter(plan, { ...NO_PLAN_FILTER, project: "Server" }).shown).toHaveLength(2);
    expect(applyPlanFilter(plan, { ...NO_PLAN_FILTER, assignee: UNASSIGNED }).shown.map((n) => n.id)).toEqual(["e"]);
  });
});

describe("personSummary", () => {
  it("counts open, blocked and held-up items, biggest holder first, ignoring finished items", () => {
    expect(personSummary(plan.nodes)).toEqual([
      { assignee: "Ann", open: 1, blocked: 0, holdingUp: 2 },
      { assignee: "Bob", open: 2, blocked: 2, holdingUp: 0 },
      { assignee: UNASSIGNED, open: 1, blocked: 0, holdingUp: 0 },
    ]);
  });
});

describe("planToCsv", () => {
  it("writes a header and one line per item", () => {
    const lines = planToCsv([plan.nodes[1]!]).trim().split("\r\n");
    expect(lines).toEqual(["Ref,Title,Kind,State,Assignee,Project,Blocked,Holding up", "BOS-2,b,ticket,in_progress,Bob,Server,yes,0"]);
  });
});
