// @vitest-environment jsdom
// BOS-2375 / BOS-2397, rebuilt for BOS-2560: the milestone rows on the Roadmap timeline, rendered.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Roadmap } from "../src/pages/Roadmap";
import { stubFetchByUrl } from "./stub-fetch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const ms = (id: string, title: string, status: string, forecast: object = {}, extra: object = {}) => ({
  id, title, targetDate: day(20), total: 4, done: 2, blocked: 0, active: 1, status, horizon: "now", pinned: null, finishedAt: null,
  forecast: { pointsDone: 21, pointsLeft: 13, unsized: 0, pace: 3, expectedFinish: day(25), daysLate: 0, ...forecast }, ...extra,
});

function stub(milestones: unknown[]) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  stubFetchByUrl({
    "/api/roadmap/features": [],
    "/api/roadmap": [{ id: "c1", name: "App Co", objectives: [{ id: "o1", title: "Launch", priority: 1, status: "active", keyResults: [], milestones }] }],
    "/api/milestones/*": [],
  });
}

describe("milestone rows (BOS-2560)", () => {
  it("shows one status chip per row, the same words as the summary line, and a warning in the warning colour", async () => {
    stub([ms("m1", "Beta", "at_risk", { daysLate: 5, unsized: 3 }), ms("m2", "Gamma", "on_track"), ms("m3", "Delta", "no_work", {}, { total: 0, done: 0 })]);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await screen.findByText("1 at risk · 1 on track · 1 with no tickets");
    const rows = screen.getAllByRole("button", { expanded: false });
    expect(rows.map((r) => r.closest("li")?.getAttribute("data-status")).sort()).toEqual(["at_risk", "no_work", "on_track"]);
    const late = screen.getByText(/5 days after its date/);
    expect(late.className).toContain("warn");
    expect(screen.getByText(/3 tickets have no size/)).toBeTruthy();
  });

  it("folds done milestones into a Done group and shows no chart until a row is opened", async () => {
    stub([ms("m1", "Alpha", "done", { pointsLeft: 0 }, { finishedAt: `${day(-4)}T10:00:00Z` }), ms("m2", "Beta", "on_track")]);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    const group = await screen.findByText(/^Done \(1, latest /);
    expect(group.closest("details")!.hasAttribute("open")).toBe(false);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(1);
  });

  it("opens a row to show its labelled chart, and says so when there is too little history", async () => {
    const week = (done: number, total: number, i: number) => ({ weekEnd: day(-7 * (7 - i)), done, total });
    const growing = [5, 7, 9, 12, 15, 17, 19, 21].map((d, i) => week(d, 30 + Math.round((i * 4) / 7), i));
    stub([ms("m1", "Beta", "on_track", {}, { burnup: growing }), ms("m2", "Gamma", "on_track", {}, { burnup: [] })]);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    const beta = (await screen.findByText("Beta")).closest("button")!;
    fireEvent.click(beta);
    expect(beta.getAttribute("aria-expanded")).toBe("true");
    const li = beta.closest("li")!;
    expect(within(li).getByText("Progress over the last 8 weeks")).toBeTruthy();
    expect(within(li).getByRole("img", { name: /Points done rose from 5 to 21 over 8 weeks; planned rose from 30 to 34/ })).toBeTruthy();
    expect(within(li).getByText(/Its pace: 3 points a week/)).toBeTruthy();
    fireEvent.click(screen.getByText("Gamma").closest("button")!);
    expect(await screen.findByText("Not enough history for a chart yet.")).toBeTruthy();
  });
});
