// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Project } from "../src/api";
import { ProjectBudget } from "../src/pages/ProjectBudget";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubSpend(monthlyCapMicros: number | null) {
  const monthStart = new Date(Date.now() - 10 * 86_400_000).toISOString();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ monthMicros: 30_000_000, totalMicros: 90_000_000, ticketCostCapMicros: null, monthlyCapMicros, monthStart, plan: [], topTickets: [] }), { status: 200, headers: { "content-type": "application/json" } })));
}

const project = { id: "11111111-1111-4111-8111-111111111111", companyId: "c1", name: "P" } as Project;

it("shows the forecast with the limit and the day it is reached", async () => {
  stubSpend(60_000_000);
  render(<ProjectBudget project={project} />);
  const line = await screen.findByText(/At this pace: about/);
  expect(line.textContent).toMatch(/by the end of the month/);
  expect(line.textContent).toContain("limit $60.00");
  expect(line.textContent).toMatch(/Reaches the limit around/);
});

it("shows the forecast without limit wording when no limit is set", async () => {
  stubSpend(null);
  render(<ProjectBudget project={project} />);
  const line = await screen.findByText(/At this pace: about/);
  expect(line.textContent).not.toMatch(/limit/i);
});
