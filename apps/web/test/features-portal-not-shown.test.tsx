// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Features } from "../src/pages/Features";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const feature = (over: Record<string, unknown>) => ({
  id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Dark mode", description: null, status: "in_progress", effort: null, driverScores: {}, milestoneId: null,
  portalVisible: true, keepOffPortal: false, publicSummary: null, publicTitle: null, showPublicly: false,
  createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 0, insightCount: 0, customerCount: 0, value: 0, demandPart: 0, priority: 0,
  tickets: { total: 0, done: 0, items: [] },
  portal: { onPortal: false, reason: "needs public summary" },
  portalShow: { shown: false, ticked: true, reason: "needs public summary" },
  ...over,
});

describe("Features page: ticked but not shown on the portal (BOS-1496)", () => {
  it("says Not shown yet with the fix, and counts n of m at the top", async () => {
    const rows = [
      feature({}),
      feature({ id: "f2", title: "Export", publicSummary: "Export your data.", portal: { onPortal: true, reason: null }, portalShow: { shown: true } }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: rows });
        if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
        return json([]);
      }),
    );
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    await screen.findByRole("checkbox", { name: "On portal: Dark mode" });
    expect(screen.getAllByText("Not shown yet").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/needs public summary: write a public summary/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("portal-count").textContent).toBe("1 of 2 ticked showing on the portal");
  });
});
