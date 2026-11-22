// @vitest-environment jsdom
// BOS-2256: the Features page's search box narrows the list by title or description.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    portalVisible: true, createdAt: "2026-10-19T09:00:00Z", demand: 2, value: 3.5, priority: 7.5,
    tickets: { total: 0, done: 0, items: [] },
    ...over,
  }) as unknown as Feature;

const rows = [
  feature({ id: "f1", title: "Gift cards" }),
  feature({ id: "f2", title: "Refunds", description: "Money back for a CARD payment" }),
  feature({ id: "f3", parentId: "f1", title: "Balance check" }),
  feature({ id: "f4", title: "Dark mode" }),
  feature({ id: "f5", parentId: "f4", title: "Night schedule" }),
];

function open() {
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

describe("Features search", () => {
  it("matches title or description ignoring case, keeps subfeatures of a match, and counts", async () => {
    open();
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search features" }), { target: { value: "CARD" } });
    expect(screen.getByRole("combobox", { name: "Status of Gift cards" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Status of Balance check" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Status of Refunds" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Status of Dark mode" })).toBeNull();
    expect(screen.getByTestId("search-count").textContent).toBe("3 of 5 features");
  });

  it("shows a matching subfeature with its parent", async () => {
    open();
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search features" }), { target: { value: "night" } });
    expect(screen.getByRole("combobox", { name: "Status of Dark mode" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Status of Night schedule" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Status of Gift cards" })).toBeNull();
  });

  it("says nothing matches and Clear brings the list back", async () => {
    open();
    await screen.findByRole("combobox", { name: "Status of Gift cards" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search features" }), { target: { value: "zzz" } });
    expect(screen.getByText(/No feature matches "zzz"/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("combobox", { name: "Status of Gift cards" })).toBeTruthy();
    expect(screen.queryByTestId("search-count")).toBeNull();
  });
});
