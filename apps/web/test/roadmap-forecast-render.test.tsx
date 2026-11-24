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

describe("burn-up and pace on the Roadmap (BOS-2397)", () => {
  const week = (done: number, total: number, i: number) => ({ weekEnd: day(-7 * (7 - i)), done, total });
  const growing = [5, 7, 9, 12, 15, 17, 19, 21].map((d, i) => week(d, 30 + Math.round((i * 4) / 7), i));

  it("shows the weekly pace and a labelled burn-up under each open milestone", async () => {
    stub([{ ...ms("m1", "Beta", "on_track", { pace: 12 }), burnup: growing }]);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await screen.findByText("Pace: 12 points a week (last 4 weeks)");
    const chart = screen.getByRole("img", { name: /Done rose from 5 to 21 points; total rose from 30 to 34 points/ });
    expect(chart.querySelectorAll("polyline")).toHaveLength(2);
  });

  it("says so when there is no pace, and a flat line reads as 'stayed'", async () => {
    stub([{ ...ms("m1", "Beta", "on_track", { pace: 0, expectedFinish: null }), burnup: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => week(0, 8, i)) }]);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await screen.findByText("Pace: no finished work in the last 4 weeks");
    expect(screen.getByRole("img", { name: /Done stayed at 0 points; total stayed at 8 points/ })).toBeTruthy();
  });
});

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
