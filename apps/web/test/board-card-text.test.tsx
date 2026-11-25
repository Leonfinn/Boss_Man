// @vitest-environment jsdom
// BOS-2497: board cards come without the ticket's long text. The search box still matches the description (it asks
// for it with ?text=1 while it has words), and the "Plan waiting" tag reads hasPlan.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";
import { stubFetchByUrl } from "./stub-fetch";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [{ id: "a1", name: "Developer" }] } as Company;
const card = (over: Record<string, unknown>) => ({ systemState: "ready", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, hasPlan: false, planApprovedAt: null, lastActivityAt: "2026-11-20T09:00:00Z", featureId: null, featureTitle: null, ...over });

function stub() {
  const boardUrls: string[] = [];
  stubFetchByUrl({
    "/api/companies/c1/projects": [{ id: "p1", companyId: "c1", name: "App", repoUrl: null }],
    "/api/companies/c1/features": { settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] },
    "/api/companies/c1/objectives": [],
    "/api/risk-tiers": [],
    "/api/companies/c1/watchdog": { settings: { enabled: false }, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 },
    "/api/projects/p1/board": (url: string) => {
      boardUrls.push(url);
      const withText = new URL(url, "http://x").searchParams.get("text") === "1";
      const text = (body: string) => (withText ? { body } : {});
      return {
        project: { id: "p1", companyId: "c1", name: "App" },
        doneTotal: 0,
        columns: [
          {
            id: "colR",
            name: "Ready",
            systemState: "ready",
            wipLimit: null,
            tickets: [
              card({ id: "t1", number: 1, title: "Fix the login page", ...text("The kanban refresh is slow on phones.") }),
              card({ id: "t2", number: 2, title: "Write release notes", ...text("Nothing about boards here.") }),
              card({ id: "t3", number: 3, title: "Plan the importer", planFirst: true, hasPlan: true }),
              card({ id: "t4", number: 4, title: "Plan the exporter", planFirst: true, hasPlan: false }),
            ],
          },
        ],
      };
    },
  });
  return boardUrls;
}
const open = () => render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
const last = (urls: string[]) => urls[urls.length - 1]!;

describe("board cards without long text (BOS-2497)", () => {
  it("the plain refresh asks for no descriptions; a search asks for them and matches a word only the description has", async () => {
    const urls = stub();
    open();
    await screen.findByText("Fix the login page");
    expect(urls.every((u) => !u.includes("text=1"))).toBe(true);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "kanban" } });
    await waitFor(() => expect(last(urls)).toContain("text=1"));
    await waitFor(() => expect(screen.queryByText("Write release notes")).toBeNull());
    expect(screen.getByText("Fix the login page")).toBeTruthy();
    // Cleared: back to the request without descriptions, and every card shows again.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), { target: { value: "" } });
    await waitFor(() => expect(last(urls)).not.toContain("text=1"));
    await screen.findByText("Write release notes");
  });

  it("says Plan waiting from hasPlan, and Planning without one", async () => {
    stub();
    open();
    const withPlan = (await screen.findByText("Plan the importer")).closest("li, article, .ticket-card, [data-ticket-id]") ?? document.body;
    expect(withPlan.textContent).toContain("Plan waiting");
    const without = screen.getByText("Plan the exporter").closest("li, article, .ticket-card, [data-ticket-id]") ?? document.body;
    expect(without.textContent).toContain("Planning");
    expect(without.textContent).not.toContain("Plan waiting");
  });
});
