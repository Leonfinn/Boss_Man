// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board, workingFor } from "../src/pages/Board";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [{ id: "a1", name: "Developer" }] } as Company;
const card = (over: Record<string, unknown>) => ({ systemState: "ready", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null, ...over });
const feat = (id: string, title: string) => ({ id, companyId: "c1", areaId: null, parentId: null, title, description: null, status: "in_progress", effort: null, driverScores: {}, milestoneId: null, portalVisible: false, createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 0, insightCount: 0, customerCount: 0, value: 0, demandPart: 0, priority: 0, tickets: { total: 0, done: 0, items: [] } });

function stub() {
  const since = new Date(Date.now() - 23 * 60_000).toISOString();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.endsWith("/board"))
        return json({
          project: { id: "p1", companyId: "c1", name: "App" },
          columns: [
            {
              id: "col1", name: "Ready", systemState: "ready", wipLimit: null,
              tickets: [
                card({ id: "t1", title: "Alpha task", featureId: "f1", featureTitle: "Dark mode", working: ["Developer"], workingSince: since, assigneeAgentId: "a1" }),
                card({ id: "t2", title: "Beta task", featureId: "f1", featureTitle: "Dark mode", assigneeAgentId: "a1" }),
                card({ id: "t3", title: "Gamma task", featureId: "f2", featureTitle: "Export", working: ["Developer"], workingSince: since }),
                card({ id: "t4", title: "Delta task" }),
              ],
            },
          ],
        });
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [feat("f1", "Dark mode"), feat("f2", "Export")] });
      return json([]);
    }),
  );
}
const open = () => render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
const shown = () => ["Alpha", "Beta", "Gamma", "Delta"].filter((n) => screen.queryByText(`${n} task`, { selector: "h3 a" }));

describe("workingFor", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("gives the run's length in short form, and now in the first minute", () => {
    expect(workingFor("2026-10-27T11:37:00Z", now)).toBe("23m");
    expect(workingFor("2026-10-27T09:00:00Z", now)).toBe("3h");
    expect(workingFor("2026-10-27T11:59:40Z", now)).toBe("now");
    // An older server sends no start time.
    expect(workingFor(undefined, now)).toBe("now");
  });
});

describe("board filters", () => {
  it("shows how long an agent has been working on a card", async () => {
    stub();
    open();
    const alpha = (await screen.findByText("Alpha task", { selector: "h3 a" })).closest("article")!;
    expect(alpha.textContent).toContain("23m");
  });

  it("filters by feature, including No feature, and by Working now, and combines them", async () => {
    stub();
    open();
    await screen.findByText("Alpha task", { selector: "h3 a" });
    const select = (await screen.findByLabelText("Feature")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Export" });
    expect(shown()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);

    fireEvent.change(select, { target: { value: "f1" } });
    expect(shown()).toEqual(["Alpha", "Beta"]);
    fireEvent.change(select, { target: { value: "none" } });
    expect(shown()).toEqual(["Delta"]);
    fireEvent.change(select, { target: { value: "any" } });

    const working = screen.getByRole("button", { name: "Working now" });
    fireEvent.click(working);
    expect(working.getAttribute("aria-pressed")).toBe("true");
    expect(shown()).toEqual(["Alpha", "Gamma"]);

    // Both together, and with the assignee filter.
    fireEvent.change(select, { target: { value: "f1" } });
    expect(shown()).toEqual(["Alpha"]);
    fireEvent.change(screen.getByLabelText("Assigned to"), { target: { value: "a1" } });
    expect(shown()).toEqual(["Alpha"]);
    fireEvent.change(select, { target: { value: "f2" } });
    expect(shown()).toEqual([]);
  });

  it("treats a saved feature that is not in the list as Any feature", async () => {
    sessionStorage.setItem("board-filters", JSON.stringify({ feature: "gone", working: false }));
    stub();
    open();
    await screen.findByRole("option", { name: "Export" });
    expect(shown()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect((screen.getByLabelText("Feature") as HTMLSelectElement).value).toBe("any");
  });

  it("remembers both choices", async () => {
    stub();
    open();
    await screen.findByRole("option", { name: "Export" });
    fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "f2" } });
    fireEvent.click(screen.getByRole("button", { name: "Working now" }));
    cleanup();
    open();
    await screen.findByText("Gamma task", { selector: "h3 a" });
    expect(shown()).toEqual(["Gamma"]);
    expect(screen.getByRole("button", { name: "Working now" }).getAttribute("aria-pressed")).toBe("true");
  });
});
