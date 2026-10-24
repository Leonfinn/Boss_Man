// @vitest-environment jsdom
// QA coverage for the kanban feature-state toggles: the all-on case and
// unreadable or stale saved choices, which the build test does not cover.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const card = (over: Record<string, unknown>) => ({ systemState: "ready", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null, ...over });
const feature = (over: Record<string, unknown> = {}) => ({
  id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Dark mode", description: null, status: "in_progress", effort: null, driverScores: {}, milestoneId: null, portalVisible: false,
  createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 0, insightCount: 0, customerCount: 0, value: 0, demandPart: 0, priority: 0,
  tickets: { total: 0, done: 0, items: [] },
  ...over,
});
const list = [
  feature({ id: "f1", title: "Dark mode", status: "in_progress" }),
  feature({ id: "f2", title: "Export", status: "released" }),
  feature({ id: "f3", title: "Sparkle", status: "idea" }),
  feature({ id: "f4", title: "Won't build", status: "declined" }),
];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.endsWith("/board")) return json({ project: { id: "p1", companyId: "c1", name: "App" }, columns: [{ id: "col1", name: "Ready", systemState: "ready", wipLimit: null, tickets: [card({ id: "t1", title: "Build the toggle" })] }] });
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: list });
      if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: false, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      return json([]);
    }),
  );
}

const openFeatures = async (waitTitle = "Dark mode") => {
  stub();
  render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Features" }));
  await screen.findByRole("article", { name: `Feature ${waitTitle}` });
};

describe("feature state toggles (QA)", () => {
  it("shows every feature again with all six states switched on", async () => {
    await openFeatures();
    for (const name of ["Declined (1)", "Idea (1)", "In progress (1)", "Released (1)"]) {
      const button = screen.getByRole("button", { name });
      if (button.getAttribute("aria-pressed") !== "true") fireEvent.click(button);
    }
    expect(screen.getByRole("article", { name: "Feature Won't build" })).toBeTruthy();
    expect(screen.queryByText(/No features in the states/)).toBeNull();
    for (const title of ["Dark mode", "Export", "Sparkle", "Won't build"]) {
      expect(screen.getByRole("article", { name: `Feature ${title}` })).toBeTruthy();
    }
  });

  it("falls back to the default after a corrupt saved value", async () => {
    sessionStorage.setItem("board-feature-states", "{not json");
    await openFeatures();
    expect(screen.getByRole("button", { name: "Declined (1)" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "In progress (1)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("article", { name: "Feature Won't build" })).toBeNull();
    expect(screen.getByRole("article", { name: "Feature Dark mode" })).toBeTruthy();
  });

  it("ignores unknown names in a saved choice and keeps the known ones", async () => {
    sessionStorage.setItem("board-feature-states", JSON.stringify(["released", "wibbled", 7]));
    await openFeatures("Export");
    expect(screen.getByRole("button", { name: "Released (1)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "In progress (1)" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Declined (1)" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("article", { name: "Feature Sparkle" })).toBeNull();
    expect(screen.queryByRole("article", { name: "Feature Dark mode" })).toBeNull();
    expect(screen.getByRole("article", { name: "Feature Export" })).toBeTruthy();
    expect(screen.queryByText(/No features in the states/)).toBeNull();
  });
});