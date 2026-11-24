// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Workflow } from "../src/pages/Workflow";
import { stubFetchByUrl } from "./stub-fetch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const card = { days: 14, costBasis: null, byRole: [], byAgent: [], handoffs: [], features: [], sizes: [], sizeNotes: [] };

const change = (over: Record<string, unknown> = {}) => ({
  id: "ch1",
  lever: "playbook",
  summary: "Add the playbook \"regression-tests\" for qa agents",
  approver: "ceo",
  status: "skipped",
  metricLabel: "First-time review pass rate",
  baselineText: "53%",
  afterText: null,
  target: "qa",
  appliedAt: null,
  evidence: ["APP-1"],
  reason: "adds a skill; waits for BOS-172",
  reasonLink: "product/decisions/workflow-retro-changes-why-each-was-applied-or-skipped#Skipped: class-level-regression-tests (QA agents)",
  decidedBy: "ceo",
  ...over,
});

describe("workflow changes", () => {
  it("shows who decided, the reason and a link to the exact wiki section", async () => {
    stubFetchByUrl({ "/api/companies/c1/retros/latest": { retro: null, changes: [change()] }, "/api/companies/c1/workflow": card });
    render(<Workflow company={company} />);
    expect(await screen.findByText("Skipped by CEO: adds a skill; waits for BOS-172")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Why →" }).getAttribute("href")).toBe(
      "#/wiki/c1/product/decisions/workflow-retro-changes-why-each-was-applied-or-skipped#Skipped: class-level-regression-tests (QA agents)",
    );
  });

  it("says No reason recorded for a change decided before reasons were stored", async () => {
    stubFetchByUrl({
      "/api/companies/c1/retros/latest": { retro: null, changes: [change({ reason: null, reasonLink: null, decidedBy: null })] },
      "/api/companies/c1/workflow": card,
    });
    render(<Workflow company={company} />);
    expect(await screen.findByText("No reason recorded")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Why →" })).toBeNull();
  });
});
