// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { download } from "../src/csv";
import { ProjectsPage } from "../src/pages/Settings";
import { projectsToCsv, type ProjectSummary } from "../src/pages/settings/Projects";

vi.mock("../src/csv", async (orig) => ({ ...(await orig<typeof import("../src/csv")>()), download: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(download).mockClear();
  window.history.replaceState(null, "", "/");
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const project = (id: string, name: string, archivedAt: string | null = null) => ({ id, companyId: "c1", name, repoUrl: null, defaultBranch: "main", landing: "merge", gitHost: null, gitApiBase: null, verifyCommand: null, deepVerifyCommand: null, ticketCostCapMicros: null, reviewPolicy: null, createdAt: "", archivedAt });
const stats: ProjectSummary = { projectId: "p1", open: 4, inReview: 1, blocked: 2, pointsLeft: 9, unsized: 2, finishedLast30Days: 6, monthMicros: 42_500_000, monthlyCapMicros: 100_000_000, lastMergeAt: "2026-11-20T10:00:00.000Z" };
const HEAD = "project,open,in_review,blocked,points_left,unsized,done_last_30_days,month_spend_usd,monthly_cap_usd,last_merge_at";

describe("projectsToCsv (BOS-2502)", () => {
  it("writes the header and one row per project in the order given, blank cap and merge when there is none", () => {
    const figures: Record<string, ProjectSummary> = { a: { ...stats, projectId: "a" }, b: { ...stats, projectId: "b", blocked: undefined, monthlyCapMicros: null, lastMergeAt: null, monthMicros: 0 } };
    const csv = projectsToCsv([{ id: "b", name: "Beta" }, { id: "a", name: "Alpha" }], (id) => figures[id]);
    expect(csv).toBe(`${HEAD}\r\nBeta,4,1,0,9,2,6,0.00,,\r\nAlpha,4,1,2,9,2,6,42.50,100.00,2026-11-20T10:00:00.000Z\r\n`);
  });

  it("quotes a name with a comma or quote, guards a formula-like name, and leaves figures blank when they haven't loaded", () => {
    const csv = projectsToCsv([{ id: "x", name: 'Web, "new"' }, { id: "y", name: "=cmd" }], () => undefined);
    expect(csv.split("\r\n").slice(1, 3)).toEqual(['"Web, ""new""",,,,,,,,,', "'=cmd,,,,,,,,,"]);
  });
});

describe("Download CSV on the Projects page", () => {
  it("saves the active projects in the chosen sort, archived left out, as projects-<company>-<date>.csv", async () => {
    window.history.replaceState(null, "", "/#/projects?sort=blocked");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
        if (url === "/api/companies/c1/projects") return json([project("p1", "Alpha"), project("p2", "Beta"), project("p3", "Gone", "2026-01-01T00:00:00Z")]);
        if (url === "/api/companies/c1/projects-summary") return json({ projects: [{ ...stats, projectId: "p1", blocked: 0 }, { ...stats, projectId: "p2", blocked: 3 }, { ...stats, projectId: "p3", blocked: 5 }] });
        if (url.endsWith("/check-presets")) return json({ detected: [], standard: [], none: { id: "none", label: "Nothing", command: null, plain: "", needs: [] }, tools: null, error: null });
        return json({});
      }),
    );
    render(<ProjectsPage companies={[company]} companyId="c1" go={vi.fn()} />);
    await screen.findByText(/^4 open, 1 in review, 3 blocked/);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(download).toHaveBeenCalledTimes(1);
    const [name, text] = vi.mocked(download).mock.calls[0]!;
    expect(name).toMatch(/^projects-app-co-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = text.split("\r\n").filter(Boolean).map((l) => l.split(",")[0]);
    expect(rows).toEqual(["project", "Beta", "Alpha"]);
  });
});
