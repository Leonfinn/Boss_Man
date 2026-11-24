// @vitest-environment jsdom
// BOS-2517: the Download CSV button on each Roadmap tab, clicked on the real page; the file is caught at download().
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Roadmap } from "../src/pages/Roadmap";
import { stubFetchByUrl } from "./stub-fetch";

const saved = vi.hoisted(() => ({ files: [] as Array<{ name: string; text: string }> }));
vi.mock("../src/csv", async (orig) => ({ ...(await orig<typeof import("../src/csv")>()), download: (name: string, text: string) => void saved.files.push({ name, text }) }));

vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
afterEach(() => {
  cleanup();
  saved.files.length = 0;
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const feature = (id: string, title: string, column: string, extra: object = {}) => ({
  id, title, status: "planned", rank: null, horizon: null, column, priority: 1, releasedAt: null, objective: null,
  publicSummary: null, showPublicly: false, tickets: { total: 4, done: 1 }, milestones: [], ...extra,
});
const fc = { pointsDone: 5, pointsLeft: 8, unsized: 0, pace: 4, expectedFinish: "2026-12-10", daysLate: 9 };
const ms = (id: string, title: string, status: string, targetDate: string) => ({ id, title, targetDate, total: 8, done: 3, blocked: 0, active: 1, status, horizon: "now", pinned: null, forecast: fc });

describe("Roadmap Download CSV (BOS-2517)", () => {
  it("Roadmap tab: one row per feature, Now then Next then Released, awkward titles quoted or guarded", async () => {
    stubFetchByUrl({
      "/api/roadmap": [{ id: "c1", name: "App Co", objectives: [] }],
      "/api/roadmap/features": [
        {
          id: "c1",
          name: "App Co",
          features: [
            feature("f3", "Sign-in", "released", { releasedAt: "2026-10-01T00:00:00Z", showPublicly: true }),
            feature("f2", 'Export, "quoted"', "next"),
            feature("f1", "=SUM(A1)", "now", { rank: 1 }),
          ],
        },
      ],
    });
    render(<Roadmap companies={[company]} tab="features" go={() => {}} />);
    await screen.findByRole("link", { name: "=SUM(A1)" });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(saved.files).toHaveLength(1);
    expect(saved.files[0]!.name).toMatch(/^roadmap-features-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = saved.files[0]!.text.trim().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^App Co,Now,1,'=SUM\(A1\),/);
    expect(lines[2]).toMatch(/^App Co,Next,,"Export, ""quoted""",/);
    expect(lines[3]).toMatch(/^App Co,Released,,Sign-in,.*,2026-10-01,yes$/);
  });

  it("Timeline tab: Late and days late are in the file, and a done milestone only when Show done work is on", async () => {
    stubFetchByUrl({
      "/api/roadmap/features": [],
      "/api/roadmap": (url: string) => [
        {
          id: "c1",
          name: "App Co",
          objectives: [{ id: "o1", title: "Launch", priority: 1, status: "active", keyResults: [], milestones: [ms("m1", "Beta", "late", "2026-11-01"), ...(url.includes("closed=1") ? [ms("m2", "Alpha", "done", "2026-09-01")] : [])] }],
        },
      ],
    });
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await screen.findAllByText("Beta");
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    let lines = saved.files[0]!.text.trim().split("\r\n");
    expect(saved.files[0]!.name).toMatch(/^roadmap-milestones-/);
    expect(lines).toEqual([lines[0], "App Co,Launch,Beta,2026-11-01,Late,3,8,8,2026-12-10,9"]);

    fireEvent.click(screen.getByLabelText("Show done work"));
    await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    lines = saved.files[1]!.text.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toContain("Alpha,2026-09-01,Done");
  });
});
