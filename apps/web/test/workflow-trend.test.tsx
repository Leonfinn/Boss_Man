// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Workflow } from "../src/pages/Workflow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const week = (weekStart: string, rest: object = {}) => ({ weekStart, partial: false, done: 0, firstPassRate: null, meanRework: null, medianCycleMs: null, costPerDoneMicros: null, ...rest });

describe("Workflow: week by week", () => {
  it("shows a row per week, dashes for an empty week, and the part-week last", async () => {
    const body = {
      days: 14,
      costBasis: "estimate",
      byRole: [],
      byAgent: [],
      handoffs: [],
      features: [],
      sizes: [],
      sizeNotes: [],
      trend: [
        week("2026-11-10T00:00:00.000Z", { done: 4, firstPassRate: 0.75, meanRework: 0.5, medianCycleMs: 90 * 60_000, costPerDoneMicros: 2_500_000 }),
        week("2026-11-17T00:00:00.000Z"),
        week("2026-11-24T00:00:00.000Z", { partial: true, done: 1 }),
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));
    render(<Workflow company={{ id: "c1", name: "Acme" } as Company} />);
    const h = await screen.findByRole("heading", { name: "Week by week" });
    const rows = within(h.closest("section")!).getAllByRole("row").slice(1);
    expect(rows.map((r) => Array.from(r.querySelectorAll("td")).map((c) => c.textContent))).toEqual([
      ["10 Nov", "4", "75%", "0.5", "1.5h", "$2.50"],
      ["17 Nov", "0", "–", "–", "–", "–"],
      ["24 Nov (this week so far)", "1", "–", "–", "–", "–"],
    ]);
    expect(rows[2]!.className).toBe("muted");
  });
});
