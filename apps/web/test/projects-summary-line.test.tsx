// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ProjectsPage } from "../src/pages/Settings";
import { projectSummaryLine } from "../src/pages/settings/Projects";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const project = (id: string, name: string, archivedAt: string | null = null) => ({ id, companyId: "c1", name, repoUrl: null, defaultBranch: "main", landing: "merge", gitHost: null, gitApiBase: null, verifyCommand: null, deepVerifyCommand: null, ticketCostCapMicros: null, reviewPolicy: null, createdAt: "", archivedAt });
const stats = { projectId: "p1", open: 4, inReview: 1, pointsLeft: 9, unsized: 2, finishedLast30Days: 6, monthMicros: 42_000_000, monthlyCapMicros: 100_000_000, lastMergeAt: null };

describe("projectSummaryLine", () => {
  it("says the figures in words, with the cap or none, unsized and never", () => {
    expect(projectSummaryLine(stats)).toBe("4 open, 1 in review · 9 points left (2 unsized) · 6 done in the last 30 days · $42.00 of $100.00 this month · last merge: never");
    expect(projectSummaryLine({ ...stats, pointsLeft: 1, unsized: 0, monthlyCapMicros: null })).toContain("1 point left · 6 done");
    expect(projectSummaryLine({ ...stats, monthlyCapMicros: null })).toContain("$42.00 this month, no cap");
  });
});

describe("projects page summary line", () => {
  const stub = (summary: () => Response) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
        if (url === "/api/companies/c1/projects") return json([project("p1", "Website"), project("p2", "Old", "2026-01-01T00:00:00Z")]);
        if (url === "/api/companies/c1/projects-summary") return summary();
        if (url.endsWith("/check-presets")) return json({ detected: [], standard: [], none: { id: "none", label: "Nothing", command: null, plain: "", needs: [] }, tools: null, error: null });
        return json({});
      }),
    );

  it("shows the line for live and archived projects from one request", async () => {
    stub(() => new Response(JSON.stringify({ projects: [stats, { ...stats, projectId: "p2", open: 0 }] }), { headers: { "content-type": "application/json" } }));
    render(<ProjectsPage companies={[company]} companyId="c1" go={vi.fn()} />);
    expect(await screen.findByText(/^4 open, 1 in review/)).toBeTruthy();
    expect(screen.getByText(/^0 open, 1 in review/)).toBeTruthy();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "/api/companies/c1/projects-summary");
    expect(calls).toHaveLength(1);
  });

  it("keeps today's line and shows Retry when the figures fail", async () => {
    stub(() => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } }));
    render(<ProjectsPage companies={[company]} companyId="c1" go={vi.fn()} />);
    expect(await screen.findByText(/Repo set|No repo/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
});
