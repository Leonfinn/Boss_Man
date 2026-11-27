// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Features } from "../src/pages/Features";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const task = (id: string, state: string, outcome: string | null = null) => ({ id, title: `Task ${id}`, state, outcome, assignee: null });
const tasks = [task("a", "blocked"), task("b", "blocked"), task("c", "review"), task("d", "done"), task("e", "done"), task("f", "done", "cancelled")];

function show(items: ReturnType<typeof task>[]) {
  const row = { id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Big feature", description: null, status: "in_progress", effort: null, driverScores: {}, milestoneId: null, portalVisible: false, keepOffPortal: false, keepOffReason: null, publicSummary: null, publicTitle: null, showPublicly: false, priorityOne: false, createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 0, insightCount: 0, customerCount: 0, value: 0, demandPart: 0, priority: 0, tickets: { total: items.length, done: 0, items }, portal: { onPortal: false, reason: null } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [row] });
      if (url.startsWith("/api/features/")) return json({ feature: row, drivers: [], settings: { demandWeight: 1 }, maxDemand: 0, subfeatures: [], insights: [], tickets: items });
      if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      return json([]);
    }),
  );
  window.location.hash = "#/features/c1/f1";
  const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [], projects: [] };
  render(<Features companies={[company]} companyId="c1" featureId="f1" go={() => {}} />);
}

describe("Feature page: filter tasks by status", () => {
  it("shows counts, filters the list, and says so when nothing matches", async () => {
    show(tasks);
    const all = await screen.findByRole("button", { name: "All 6" });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Open 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelled 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Blocked 2" }));
    expect(screen.getByText("Task a")).toBeTruthy();
    expect(screen.queryByText("Task c")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open 3" }));
    expect(screen.getByText("Task c")).toBeTruthy();
    expect(screen.queryByText("Task d")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Backlog 0" }));
    expect(screen.getByText("No tasks with this status")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All 6" }));
    expect(screen.getByText("Task f")).toBeTruthy();
  });
});
