// @vitest-environment jsdom
// BOS-2458: a key result shows how long since its last reading, a sparkline, a stale tag and a fold of readings.
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
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function stub(krs: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/api/roadmap/features")) return json([]);
      if (String(url).includes("/api/roadmap")) return json([{ id: "c1", name: "App Co", objectives: [{ id: "o1", title: "Launch", priority: 1, status: "active", keyResults: krs, milestones: [] }] }]);
      return json([]);
    }),
  );
}

describe("key result history (BOS-2458)", () => {
  it("a recent key result shows its age, a sparkline and the readings, with no stale tag", async () => {
    stub([
      { id: "k1", title: "Users", current: 30, target: 50, unit: "users", progress: 0.6, readings: [
        { at: daysAgo(9), value: 10, by: "the owner" },
        { at: daysAgo(2), value: 30, by: "Ada" },
      ] },
    ]);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    expect(await screen.findByText("updated 2 days ago")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Last 2 readings of Users" })).toBeTruthy();
    expect(screen.getByText("Readings (2)")).toBeTruthy();
    expect(screen.queryByText(/Not updated in 14 days/)).toBeNull();
  });

  it("an old or never-updated key result gets the stale tag", async () => {
    stub([
      { id: "k1", title: "Old", current: 3, target: 5, unit: null, progress: 0.6, readings: [{ at: daysAgo(20), value: 3, by: "the owner" }] },
      { id: "k2", title: "Fresh", current: null, target: 5, unit: null, progress: null, readings: [] },
    ]);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    expect(await screen.findByText("updated 20 days ago")).toBeTruthy();
    expect(screen.getByText("never updated")).toBeTruthy();
    expect(screen.getAllByText("Not updated in 14 days")).toHaveLength(2);
  });
});
