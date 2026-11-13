// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Features } from "../src/pages/Features";

// Features table (BOS-1257): values read as text with the real select laid over them, and a card per feature on a phone.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const driver = { id: "d1", name: "Reach", weight: 1 };
const task = (id: string, state: string) => ({ id, title: `Task ${id}`, state, outcome: null, assignee: null });
const feature = (over: Record<string, unknown> = {}) => ({
  id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Gift cards", description: null, status: "planned", effort: 3, driverScores: { d1: 4 }, milestoneId: null,
  portalVisible: false, keepOffPortal: false, publicSummary: null, publicTitle: null, showPublicly: false,
  createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 2, insightCount: 1, customerCount: 2, value: 3.5, demandPart: 0, priority: 7.5,
  tickets: { total: 3, done: 1, items: [task("a", "done"), task("b", "blocked"), task("c", "in_progress")] },
  portal: { onPortal: false, reason: null },
  ...over,
});

function stub(rows: Array<Record<string, unknown>>) {
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patches.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return json(rows[0]);
      }
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [driver], maxDemand: 2, features: rows });
      if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      return json([]);
    }),
  );
  return patches;
}

const phone = () =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width: 640px"), media: q, addEventListener: () => {}, removeEventListener: () => {} }));

describe("Features table cells (BOS-1257)", () => {
  it("shows values as text over a select that keeps its label, and an unscored value as a dash", async () => {
    const patches = stub([feature({ driverScores: {}, effort: null })]);
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    const score = (await screen.findByRole("combobox", { name: "Reach for Gift cards" })) as HTMLSelectElement;
    expect(score.parentElement?.classList.contains("cell")).toBe(true);
    expect(score.parentElement?.classList.contains("empty")).toBe(true);
    // (the select's own "–" option is also in the cell, so read the visible text span)
    expect(score.parentElement?.querySelector(".cell-text")?.textContent).toBe("–");
    // Status keeps the word, in the tag.
    expect(screen.getByRole("combobox", { name: "Status of Gift cards" }).parentElement?.textContent).toContain("Planned");
    fireEvent.change(score, { target: { value: "4" } });
    await waitFor(() => expect(patches).toEqual([{ url: "/api/features/f1", body: { driverScores: { d1: 4 } } }]));
  });

  it("says the work as 'done', and a blocked task on its own line", async () => {
    stub([feature()]);
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    expect(await screen.findByRole("button", { name: "1 of 3 done" })).toBeTruthy();
    expect(screen.getByText("⚠ 1 blocked")).toBeTruthy();
    expect(screen.queryByText("On portal")).toBeNull();
  });

  it("keeps the intro to one line with the portal rules behind a toggle, and long headings in a 2-line span with the full name as tooltip", async () => {
    stub([feature()]);
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    await screen.findByRole("combobox", { name: "Reach for Gift cards" });
    expect(screen.queryByText(/Visitors see the public summary/)).toBeNull();
    const toggle = screen.getByRole("button", { name: "How the portal works" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText(/Visitors see the public summary/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Less" }).getAttribute("aria-expanded")).toBe("true");
    const head = document.querySelector("th .th-clamp");
    expect(head?.textContent).toBe("Reach");
    expect(head?.parentElement?.getAttribute("title")).toContain("Reach");
    // New feature and the sort row share one bar
    expect(document.querySelectorAll(".features-toolbar").length).toBe(1);
    expect(screen.getByRole("textbox", { name: "New feature" })).toBeTruthy();
  });

  it("on a phone shows one card per feature with the same controls, and edits save the same way", async () => {
    phone();
    const patches = stub([feature(), feature({ id: "f2", parentId: "f1", title: "Sub card", tickets: { total: 0, done: 0, items: [] } })]);
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    await screen.findByRole("combobox", { name: "Effort of Gift cards" });
    expect(document.querySelectorAll("table").length).toBe(0);
    expect(document.querySelectorAll(".fcard").length).toBe(2);
    expect(document.querySelector(".fcard.sub")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tasks: 1 of 3 complete/ })).toBeTruthy();
    expect(screen.getAllByText("On portal").length).toBe(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "On portal: Gift cards" }));
    await waitFor(() => expect(patches).toEqual([{ url: "/api/features/f1", body: { portalVisible: true } }]));
  });
});
