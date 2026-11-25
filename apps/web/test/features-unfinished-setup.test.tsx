// @vitest-environment jsdom
// BOS-2521: the Features page's "Unfinished setup" switch, its count, and the tags naming what each feature lacks.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Driver, Feature } from "../src/api";
import { Features } from "../src/pages/Features";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const driver: Driver = { id: "d1", name: "Reach", weight: 1 } as Driver;

const feature = (over: Record<string, unknown>) =>
  ({
    id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Gift cards", description: null, status: "planned", effort: 3, driverScores: { d1: 4 },
    objectiveId: "o1", milestoneId: null, portalVisible: true, keepOffPortal: false,
    createdAt: "2026-10-19T09:00:00Z", demand: 2, value: 3.5, priority: 7.5,
    tickets: { total: 0, done: 0, items: [] },
    ...over,
  }) as unknown as Feature;

const sized = feature({ id: "f1", title: "Gift cards" });
const noSize = feature({ id: "f2", title: "Refunds", effort: null });
const noRoadmap = feature({ id: "f3", title: "Dark mode", objectiveId: null });
const noPortal = feature({ id: "f4", title: "Search", portalVisible: false, keepOffPortal: false });
const allMissing = feature({ id: "f5", title: "Export", effort: null, objectiveId: null, portalVisible: false });
const decidedOff = feature({ id: "f6", title: "Billing", portalVisible: false, keepOffPortal: true });

function open(rows: Feature[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [driver], maxDemand: 2, features: rows });
      if (url.includes("/feedback-settings")) return json({ drivers: [], areas: [] });
      return json([]);
    }),
  );
  render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
}

const status = (title: string) => screen.queryByRole("combobox", { name: `Status of ${title}` });
const switchBox = () => screen.getByRole("checkbox", { name: /Unfinished setup/ }) as HTMLInputElement;

describe("Features unfinished setup", () => {
  it("counts the features that still need something, not the sized, placed and decided ones", async () => {
    open([sized, noSize, noRoadmap, noPortal, allMissing, decidedOff]);
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    expect(screen.getByTestId("needs-setup-count").textContent).toBe("4 features need setup");
  });

  it("says 'feature needs setup' for one", async () => {
    open([sized, noSize]);
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    expect(screen.getByTestId("needs-setup-count").textContent).toBe("1 feature needs setup");
  });

  it("tags each feature with what it is missing, and nothing on a set-up feature", async () => {
    open([sized, noSize, noRoadmap, allMissing, decidedOff]);
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    const row = (title: string) => screen.getByRole("combobox", { name: `Status of ${title}` }).closest("tr") as HTMLElement;
    expect(within(row("Gift cards")).queryByText("No size")).toBeNull();
    expect(within(row("Refunds")).getByText("No size")).toBeTruthy();
    expect(within(row("Dark mode")).getByText("Not on the roadmap")).toBeTruthy();
    expect(within(row("Export")).getByText("No size")).toBeTruthy();
    expect(within(row("Export")).getByText("Not on the roadmap")).toBeTruthy();
    expect(within(row("Export")).getByText("Portal not decided")).toBeTruthy();
    expect(within(row("Billing")).queryByText("Portal not decided")).toBeNull();
  });

  it("narrows the list with the switch", async () => {
    open([sized, noSize, noRoadmap, noPortal, allMissing, decidedOff]);
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    fireEvent.click(switchBox());
    expect(switchBox().checked).toBe(true);
    expect(status("Gift cards")).toBeNull();
    expect(status("Billing")).toBeNull();
    expect(status("Refunds")).toBeTruthy();
    expect(status("Dark mode")).toBeTruthy();
    expect(status("Search")).toBeTruthy();
    expect(status("Export")).toBeTruthy();
  });

  it("works together with search", async () => {
    open([sized, noSize, noRoadmap, noPortal]);
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    fireEvent.click(switchBox());
    fireEvent.change(screen.getByRole("searchbox", { name: "Search features" }), { target: { value: "dark" } });
    expect(status("Dark mode")).toBeTruthy();
    expect(status("Refunds")).toBeNull();
    
  });

  it("keeps a subfeature under its unfinished parent, as search does", async () => {
    const sub = feature({ id: "s1", parentId: "f2", title: "Refund status" });
    open([sized, noSize, sub]);
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    fireEvent.click(switchBox());
    expect(status("Refunds")).toBeTruthy();
    expect(status("Refund status")).toBeTruthy();
    expect(status("Gift cards")).toBeNull();
  });

  it("says every feature is set up when the switch finds nothing", async () => {
    open([sized, decidedOff]);
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    fireEvent.click(switchBox());
    expect(screen.getByTestId("setup-empty").textContent).toBe("Every feature is set up");
  });
});
