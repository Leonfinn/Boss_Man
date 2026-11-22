// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, FeatureRoadmapCompany, RoadmapFeature } from "../src/api";
import { Roadmap } from "../src/pages/Roadmap";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

const feature = (over: Partial<RoadmapFeature> = {}): RoadmapFeature => ({
  id: "f1",
  title: "A feature",
  status: "planned",
  rank: null,
  horizon: null,
  column: "next",
  priority: 3,
  releasedAt: null,
  objective: { id: "o1", title: "Launch the beta", priority: 1 },
  publicSummary: null,
  showPublicly: false,
  tickets: { total: 7, done: 4 },
  milestones: [],
  ...over,
});

const board: FeatureRoadmapCompany[] = [
  {
    id: "c1",
    name: "App Co",
    features: [
      feature({ id: "f1", title: "Dark mode", status: "in_progress", column: "now", rank: 2, milestones: [{ id: "m1", title: "Beta", targetDate: "2026-12-01", pinned: null }] }),
      feature({ id: "f2", title: "CSV export" }),
      feature({ id: "f3", title: "Mobile app", column: "later", objective: null, tickets: { total: 2, done: 0 } }),
      feature({ id: "f4", title: "Sign-in", status: "released", column: "released", releasedAt: "2026-10-01T00:00:00Z" }),
    ],
  },
];

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/roadmap/features")) return json(board);
      if (String(url).includes("/api/roadmap")) return json([{ id: "c1", name: "App Co", objectives: [] }]);
      return json([]);
    }),
  );
}

describe("Roadmap page (BOS-206)", () => {
  it("shows features in Now, Next and Later, one row per objective plus Unassigned, with the Released list folded", async () => {
    stub();
    render(<Roadmap companies={[company]} tab="features" go={() => {}} />);
    expect(await screen.findByRole("link", { name: "Dark mode" })).toBeTruthy();
    const table = screen.getByRole("table", { name: "Feature roadmap for App Co" });

    // The three columns are the table headings.
    const heads = within(table).getAllByRole("columnheader");
    expect(heads.map((h) => h.textContent)).toEqual(["Objective", "Now Being built", "Next Planned and prioritised", "Later Accepted, not scheduled"]);

    // Rows: objective by priority, then the Unassigned row.
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByText(/Launch the beta/)).toBeTruthy();
    expect(within(rows[2]!).getByText("Unassigned")).toBeTruthy();
    expect(within(rows[1]!).getByRole("link", { name: "Dark mode" }).getAttribute("href")).toBe("#/features/c1/f1");
    expect(within(rows[2]!).getByRole("link", { name: "Mobile app" })).toBeTruthy();

    // A feature card carries its status, rank, priority and ticket progress.
    const dark = within(table).getByRole("link", { name: "Dark mode" }).closest("li")!;
    expect(within(dark).getByText("In progress")).toBeTruthy();
    expect(within(dark).getByText("P2")).toBeTruthy();
    expect(within(dark).getByText("Priority 3.0")).toBeTruthy();
    expect(within(dark).getByText("4 of 7 done")).toBeTruthy();
    // BOS-1126 Q13: nothing done reads "Not started", and the intro is said once (the tab's help line, not also under the title).
    const mobile = within(table).getByRole("link", { name: "Mobile app" }).closest("li")!;
    expect(within(mobile).getByText("Not started")).toBeTruthy();
    expect(screen.getAllByText(/Features in Now, Next and Later/).length).toBe(1);
    expect(screen.queryByText(/Features grouped by objective/)).toBeNull();

    // Released is a folded list until opened.
    const released = screen.getByText("Released (1)").closest("details")!;
    expect(released.hasAttribute("open")).toBe(false);
    expect(within(released).getByRole("link", { name: "Sign-in" })).toBeTruthy();
  });

  it("says what couldn't load on the Features tab, keeps the timeline's error off it, and Retry reloads", async () => {
    let featuresFail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/api/roadmap/features")) return featuresFail ? new Response(JSON.stringify({ error: "features down" }), { status: 500, headers: { "content-type": "application/json" } }) : json(board);
        if (String(url).includes("/api/roadmap")) return new Response(JSON.stringify({ error: "timeline down" }), { status: 500, headers: { "content-type": "application/json" } });
        return json([]);
      }),
    );
    render(<Roadmap companies={[company]} tab="features" go={() => {}} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the features");
    expect(screen.queryByText(/Couldn't load the timeline/)).toBeNull();
    featuresFail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Dark mode" })).toBeTruthy();
  });

  it("says what couldn't load on the Timeline tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).includes("/api/roadmap/features") ? json(board) : new Response(JSON.stringify({ error: "timeline down" }), { status: 500, headers: { "content-type": "application/json" } }))),
    );
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the timeline");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("unfolds a feature's milestones and their target dates", async () => {
    stub();
    render(<Roadmap companies={[company]} tab="features" go={() => {}} />);
    const toggle = await screen.findByRole("button", { name: "Show milestones for Dark mode" });
    expect(screen.queryByText("Beta")).toBeNull();
    fireEvent.click(toggle);
    expect(within(toggle.closest("li")!).getByText("Beta")).toBeTruthy();
    expect(within(toggle.closest("li")!).getByText(/Dec/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide milestones for Dark mode" })).toBeTruthy();
  });
});
