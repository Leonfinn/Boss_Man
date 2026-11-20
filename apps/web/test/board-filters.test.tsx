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

function stub(extra: Record<string, unknown> = {}) {
  const since = new Date(Date.now() - 23 * 60_000).toISOString();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.endsWith("/board"))
        return json({
          project: { id: "p1", companyId: "c1", name: "App" },
          ...extra,
          columns: [
            {
              id: "col1", name: "Ready", systemState: "ready", wipLimit: null,
              tickets: [
                card({ id: "t1", title: "Alpha task", featureId: "f1", featureTitle: "Dark mode", working: ["Developer working"], workingSince: since, assigneeAgentId: "a1" }),
                card({ id: "t2", title: "Beta task", featureId: "f1", featureTitle: "Dark mode", assigneeAgentId: "a1" }),
                card({ id: "t3", title: "Gamma task", featureId: "f2", featureTitle: "Export", working: ["Developer working"], workingSince: since }),
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
const openPanel = (name = "Filter") => fireEvent.click(screen.getByRole("button", { name }));
const shown = () => ["Alpha", "Beta", "Gamma", "Delta"].filter((n) => screen.queryByText(`${n} task`, { selector: "h3 a" }));

describe("workingFor", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("gives the run's length in short form, and now in the first minute", () => {
    expect(workingFor("2026-10-27T11:37:00Z", now)).toBe("23m");
    expect(workingFor("2026-10-27T09:00:00Z", now)).toBe("3h");
    expect(workingFor("2026-10-27T11:59:40Z", now)).toBe("now");
    expect(workingFor("2026-10-27T11:59:01Z", now)).toBe("now");
    // Either end of the first minute is "now", as age.ts says "just now".
    expect(workingFor("2026-10-27T12:00:00Z", now)).toBe("now");
    // An older server sends no start time.
    expect(workingFor(undefined, now)).toBe("now");
    expect(workingFor(null, now)).toBe("now");
  });

  it("floors minutes like age.ts, so it never runs a minute ahead of the Decisions card (BOS-888)", () => {
    // 59 min 40 s is still 59 minutes here; the old footer rounded it to "1h".
    expect(workingFor("2026-10-27T11:00:20Z", now)).toBe("59m");
    expect(workingFor("2026-10-27T10:00:20Z", now)).toBe("1h");
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
    openPanel();
    const select = (await screen.findByLabelText("Feature")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Export" }, { timeout: 5000 });
    expect(shown()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);

    fireEvent.change(select, { target: { value: "f1" } });
    expect(shown()).toEqual(["Alpha", "Beta"]);
    fireEvent.change(select, { target: { value: "none" } });
    expect(shown()).toEqual(["Delta"]);
    fireEvent.change(select, { target: { value: "any" } });

    const working = screen.getByRole("switch", { name: /^Working now/ });
    fireEvent.click(working);
    expect(working.getAttribute("aria-checked")).toBe("true");
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
    await screen.findByText("Alpha task", { selector: "h3 a" });
    openPanel();
    await screen.findByRole("option", { name: "Export" }, { timeout: 5000 });
    expect(shown()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect((screen.getByLabelText("Feature") as HTMLSelectElement).value).toBe("any");
    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();
  });

  it("remembers both choices, and a saved filter shows as a count and chips on arrival", async () => {
    stub();
    open();
    await screen.findByText("Alpha task", { selector: "h3 a" });
    openPanel();
    await screen.findByRole("option", { name: "Export" }, { timeout: 5000 });
    fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "f2" } });
    fireEvent.click(screen.getByRole("switch", { name: /^Working now/ }));
    cleanup();
    open();
    expect(await screen.findByText("Feature: Export", { selector: ".filter-chip span" }, { timeout: 5000 })).toBeTruthy();
    expect(shown()).toEqual(["Gamma"]);
    expect(screen.getByRole("button", { name: "Filter, 2 on" })).toBeTruthy();
    expect(screen.getByText("Working now", { selector: ".filter-chip span" })).toBeTruthy();
    openPanel("Filter, 2 on");
    expect(screen.getByRole("switch", { name: /^Working now/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("removes a filter from its chip, and Clear all leaves the search text alone", async () => {
    stub();
    open();
    await screen.findByText("Alpha task", { selector: "h3 a" });
    openPanel();
    fireEvent.click(screen.getByRole("switch", { name: /^Working now/ }));
    fireEvent.change(screen.getByLabelText("Assigned to"), { target: { value: "a1" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "task" } });
    expect(shown()).toEqual(["Alpha"]);
    expect(screen.getByRole("button", { name: "Filter, 2 on" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: assigned to Developer" }));
    expect(shown()).toEqual(["Alpha", "Gamma"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Clear all" })[0]!);
    expect(shown()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect((screen.getByRole("searchbox", { name: "Search tasks" }) as HTMLInputElement).value).toBe("task");
    expect(screen.getByRole("button", { name: "Filter" })).toBeTruthy();
  });

  it("says why a column is empty when filters emptied it, with a way out", async () => {
    stub();
    open();
    await screen.findByText("Alpha task", { selector: "h3 a" });
    openPanel();
    fireEvent.change(screen.getByLabelText("Assigned to"), { target: { value: "owner" } });
    expect(shown()).toEqual([]);
    expect(screen.getByText(/No tasks match your filters\./)).toBeTruthy();
    // Columns that were empty anyway keep their usual hint.
    expect(screen.getAllByText(/No tasks match your filters\./).length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(shown()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });

  it("says a search matched nothing, with a Clear search button, instead of the empty-column hint", async () => {
    stub();
    open();
    await screen.findByText("Alpha task", { selector: "h3 a" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "zzzqq" } });
    expect(shown()).toEqual([]);
    expect(screen.getAllByText(/No tasks match "zzzqq"\./).length).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing finished yet.")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear search" })[0]!);
    expect((screen.getByRole("searchbox", { name: "Search tasks" }) as HTMLInputElement).value).toBe("");
    expect(shown()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });

  it("opens as a non-modal dialog, closes on Escape and returns focus to the Filter button", async () => {
    stub();
    open();
    await screen.findByText("Alpha task", { selector: "h3 a" });
    const button = screen.getByRole("button", { name: "Filter" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Filter tasks" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByText("Changes apply at once. Esc closes.")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    // A click outside closes it too.
    fireEvent.click(button);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes when Tab leaves the panel without pulling focus back to Filter", async () => {
    stub();
    open();
    await screen.findByText("Alpha task", { selector: "h3 a" });
    const button = screen.getByRole("button", { name: "Filter" });
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Filter tasks" });
    // The next focus target outside the panel, as a Tab would land on it.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    fireEvent.blur(dialog, { relatedTarget: outside });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement, "focus is not pulled back to Filter").not.toBe(button);
    outside.remove();
  });

  it("is a modal bottom sheet on a phone, with Clear all and a live Show N tasks", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width: 640px"), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    stub();
    open();
    await screen.findByText("Alpha task", { selector: "h3 a" });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const dialog = screen.getByRole("dialog", { name: "Filter tasks" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: "Show 4 tasks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: /^Working now/ }));
    expect(screen.getByRole("button", { name: "Show 2 tasks" })).toBeTruthy();
    // No chips on a phone: the count on the button does that job.
    expect(document.querySelector(".filter-chip")).toBeNull();
    expect(screen.getByRole("button", { name: "Filter, 1 on" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(shown()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    fireEvent.click(screen.getByRole("button", { name: "Show 4 tasks" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("puts the company's own prefix in the search hint", async () => {
    stub();
    render(<Board companies={[{ ...company, ticketPrefix: "FERN" } as Company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
    await screen.findByText("Alpha task", { selector: "h3 a" });
    expect(screen.getByRole("searchbox", { name: "Search tasks" }).getAttribute("placeholder")).toBe("Search: FERN-12, title, words…");
  });

  it("lists runs without a ticket in a strip, shows the count, and renders agent-written text as plain text", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    stub({
      workingAgents: 3,
      withoutTicket: [{ id: "r9", agent: "Senior Developer", ticketId: null, ticket: null, purpose: null, origin: "nudge", originFrom: "CEO", originNote: evil, wakeNote: evil, runTicketId: null, startedAt: new Date(Date.now() - 5 * 60_000).toISOString() }],
    });
    open();
    const strip = await screen.findByLabelText("Working on something other than a ticket");
    expect(strip.textContent).toContain("Senior Developer");
    expect(strip.querySelector("img")).toBeNull();
    expect(strip.querySelector("a[href=\"#/runs/r9\"]")).not.toBeNull();
    await screen.findByText("Senior Developer", { exact: false });
    openPanel();
    expect(screen.getByText("Only tasks an agent is working on (3)")).toBeTruthy();
  });

  it("lists runs on another project's tickets as such, and keeps the 'other than a ticket' heading away", async () => {
    stub({
      workingAgents: 1,
      withoutTicket: [],
      otherProjects: [{ id: "r5", agent: "Dylan", purpose: null, startedAt: new Date().toISOString(), ticketId: "tx", ticketNumber: 12, ticketTitle: "Fix login", projectId: "p2", projectName: "Development" }],
    });
    open();
    const strip = await screen.findByLabelText("Working on other projects");
    expect(strip.textContent).toContain("Dylan");
    expect(strip.textContent).toContain("Development");
    expect(strip.querySelector("a[href=\"#/tickets/tx\"]")).not.toBeNull();
    expect(strip.querySelector("a[href=\"#/board/p2\"]")).not.toBeNull();
    expect(screen.queryByLabelText("Working on something other than a ticket")).toBeNull();
  });

  it("shows no strip when every working agent is on a card", async () => {
    stub({ workingAgents: 1, withoutTicket: [] });
    open();
    await screen.findByText("Alpha task", { selector: "h3 a" });
    expect(screen.queryByLabelText("Working on something other than a ticket")).toBeNull();
  });
});
