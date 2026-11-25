// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { csvName, featuresCsv, handoffsCsv, rolesCsv, sizesCsv, Workflow } from "../src/pages/Workflow";
import { stubFetchByUrl } from "./stub-fetch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stats = { done: 4, firstPassRate: 0.75, meanRework: 0.5, medianCycleMs: 90 * 60_000, costPerDoneMicros: 2_500_000, ownCostPerDoneMicros: null, watchdogFlags: 1, overrideShare: null, answered: 0 };
const d: any = {
  days: 14,
  costBasis: "estimate",
  byRole: [{ role: "web-developer", agents: 2, ...stats }],
  byAgent: [{ agentId: "a1", name: "Bungle", title: null, role: "web-developer", ...stats }],
  handoffs: [{ from: "owner", to: "developer", kind: "assign", count: 3, medianWaitMs: 30 * 60_000, bounceRate: null }],
  features: [{ id: "f1", title: "=Evil, feature", status: "building", tasksDone: 1, tasksTotal: 3, tail: [], tailFlag: true, tailLagMs: null, criticalPath: { chain: [{ id: "t1", ref: "BOS-1", title: "x", state: "done" }, { id: "t2", ref: "BOS-2", title: "y", state: "done" }], p50Ms: 60 * 60_000, p85Ms: null, ageing: [] } }],
  sizes: [{ role: "developer", size: 3, done: 12, p50CycleMs: 120 * 60_000, p85CycleMs: null, meanCostMicros: 1_234_000, meanRework: 0.25 }],
  sizeNotes: [],
};

describe("workflow CSV", () => {
  it("writes plain numbers a spreadsheet can chart", () => {
    expect(rolesCsv(d, false)).toBe(
      "Role,Agents,Done,Right first time (%),Rework rounds,Time to finish (min),Own cost ($),Ticket cost ($),Watchdog flags,Answers changed (%)\r\nWeb developer,2,4,75,0.5,90,,2.5,1,\r\n",
    );
    expect(rolesCsv(d, true).split("\r\n")[1]).toBe("Bungle,Web developer,4,75,0.5,90,,2.5,1,");
    expect(handoffsCsv(d).split("\r\n")[1]).toBe("Owner,Developer,Assigned,3,30,");
    expect(sizesCsv(d).split("\r\n")[1]).toBe("Developer,3,12,120,,1.23,0.3");
  });

  it("quotes a formula-looking feature name and joins the critical path", () => {
    expect(featuresCsv(d).split("\r\n")[1]).toBe(`"'=Evil, feature",Building,1,3,Yes,,,BOS-1 > BOS-2,60,`);
  });

  it("names the file by table and period", () => {
    expect(csvName("handoffs", 30)).toMatch(/^workflow-handoffs-last-30-days-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe("Workflow load error", () => {
  it("offers Retry that loads again", async () => {
    let calls = 0;
    const boom = () => {
      calls++;
      return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
    };
    stubFetchByUrl({ "/api/companies/c1/workflow": boom, "/api/companies/c1/retros/latest": boom });
    render(<Workflow company={{ id: "c1", name: "Acme" } as Company} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    const before = calls;
    fireEvent.click(retry);
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });
});
