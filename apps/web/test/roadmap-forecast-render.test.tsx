// @vitest-environment jsdom
// BOS-2375: the forecast lines under the Roadmap timeline, rendered.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Roadmap } from "../src/pages/Roadmap";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const ms = (id: string, title: string, status: string, forecast: object) => ({
  id, title, targetDate: day(20), total: 4, done: 2, blocked: 0, active: 1, status, horizon: "now", pinned: null,
  forecast: { pointsDone: 21, pointsLeft: 13, unsized: 0, pace: 3, expectedFinish: day(25), daysLate: 0, ...forecast },
});

function stub(milestones: unknown[]) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/roadmap/features")) return json([]);
      if (String(url).includes("/api/roadmap")) return json([{ id: "c1", name: "App Co", objectives: [{ id: "o1", title: "Launch", priority: 1, status: "active", keyResults: [], milestones }] }]);
      return json([]);
    }),
  );
}

describe("milestone forecast on the Roadmap (BOS-2375)", () => {
  it("shows days late in the warning colour, unsized tickets, and the no-pace message", async () => {
    stub([
      ms("m1", "Beta", "at_risk", { daysLate: 5, unsized: 3 }),
      ms("m2", "Gamma", "on_track", { expectedFinish: null }),
    ]);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    const late = await screen.findByText(/5 days after the target/);
    expect(late.getAttribute("style")).toContain("var(--amber)");
    expect(screen.getByText(/3 tickets have no size/)).toBeTruthy();
    expect(screen.getByText(/No finished work in the last 4 weeks to estimate from\./)).toBeTruthy();
  });

  it("shows no forecast for a done milestone", async () => {
    stub([ms("m1", "Alpha", "done", { pointsLeft: 0 }), ms("m2", "Beta", "on_track", {})]);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await screen.findByText(/21 of 34 points done/);
    expect(screen.getAllByText(/points done/)).toHaveLength(1);
  });
});
