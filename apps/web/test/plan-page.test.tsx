// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Plan as PlanData } from "../src/api";
import { Plan } from "../src/pages/Plan";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const company = { id: "c1", name: "App Co", mission: "x", paused: false, agents: [] } as Company;

const longTitle = "Skills: plan and build the CEO's add-a-skill flow (own drafts and review) without blocking the queue";
const plan: PlanData = {
  nodes: [
    { id: "t1", kind: "ticket", title: longTitle, state: "in_progress", open: true, link: "#/ticket/t1", assignee: "Web Developer", project: "Development", layer: 0, blocked: false, causes: [], holdingUp: 1 },
    { id: "t2", kind: "ticket", title: "Infra: register the Cloudflare tunnel", state: "blocked", open: true, link: "#/ticket/t2", assignee: null, project: "Development", layer: 1, blocked: true, causes: ["t1"], holdingUp: 0 },
  ],
  edges: [{ id: "e1", from: "t1", to: "t2" }],
  columns: [["t1"], ["t2"]],
};

function stubPlan() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(plan), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

describe("Plan page (BOS-203)", () => {
  it("shows full titles on hover and the summary with last updated and refresh", async () => {
    stubPlan();
    render(<Plan companies={[company]} companyId="c1" go={() => {}} />);
    const graph = within(await screen.findByRole("region", { name: "Dependency graph" }));
    const title = await graph.findByRole("link", { name: longTitle });
    expect(title.getAttribute("title")).toBe(longTitle);
    expect(screen.getByText("1 blocked task across 2 items.")).toBeTruthy();
    expect(await screen.findByText(/^Last updated .+ \(just now\)$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("fetches the plan again when Refresh is pressed", async () => {
    const calls = stubPlan();
    render(<Plan companies={[company]} companyId="c1" go={() => {}} />);
    const graph = within(await screen.findByRole("region", { name: "Dependency graph" }));
    await graph.findByRole("link", { name: longTitle });
    const before = calls.filter((u) => u.endsWith("/plan")).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await vi.waitFor(() => expect(calls.filter((u) => u.endsWith("/plan")).length).toBeGreaterThan(before));
  });
});
