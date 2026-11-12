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
const feature = (over: Record<string, unknown> = {}) => ({
  id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Dark mode", description: null, status: "in_progress", effort: null, rank: null, horizon: null, driverScores: {},
  milestoneId: null, objectiveId: null, portalVisible: false, keepOffPortal: false, publicSummary: null, publicTitle: null, showPublicly: false,
  createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 0, insightCount: 0, customerCount: 0, value: 0, demandPart: 0, priority: 0,
  tickets: { total: 0, done: 0, items: [] },
  portal: { onPortal: false, reason: "needs public summary" },
  ...over,
});

function stub(features: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features });
      if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      return json([]);
    }),
  );
}

describe("Features list: what visitors will see (BOS-997)", () => {
  const titled = feature({ id: "f1", title: "Dark mode", portalVisible: true, publicTitle: "Night reading", publicSummary: "A dark theme you can switch on.\nTeam-only detail.", portal: { onPortal: true, reason: null } });
  const fromSummary = feature({ id: "f2", title: "CSV export", portalVisible: true, publicTitle: null, publicSummary: "Download reports as spreadsheets.\nInternal detail.", portal: { onPortal: true, reason: null } });
  const offPortal = feature({ id: "f3", title: "Rotate API keys", portalVisible: false, publicTitle: null, publicSummary: "Rotate the keys now.", portal: { onPortal: false, reason: "security" } });

  it("shows the public title on a portal feature", async () => {
    stub([titled]);
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    const line = await screen.findByText((_, el) => el?.tagName === "SMALL" && el.textContent === "Visitors will see: Night reading");
    expect(line).toBeTruthy();
    expect(line.textContent).not.toContain("summary");
  });

  it("falls back to the summary's first line, without a second hint line on the row (BOS-1257)", async () => {
    stub([fromSummary]);
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    expect(await screen.findByText((_, el) => el?.tagName === "SMALL" && el.textContent === "Visitors will see: Download reports as spreadsheets.")).toBeTruthy();
    expect(screen.queryByText("from the summary, no public title set")).toBeNull();
  });

  it("shows no such line on a feature that is off the portal", async () => {
    stub([offPortal]);
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    expect(await screen.findByRole("checkbox", { name: "On portal: Rotate API keys" })).toBeTruthy();
    expect(screen.queryByText(/Visitors will see/)).toBeNull();
  });

  it("shows no such line on a ticked feature still waiting for a public summary", async () => {
    stub([feature({ id: "f4", title: "Saved views", portalVisible: true, publicSummary: null, portal: { onPortal: false, reason: "needs public summary" } })]);
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    expect(await screen.findByText("needs public summary")).toBeTruthy();
    expect(screen.queryByText(/Visitors will see/)).toBeNull();
  });
});
