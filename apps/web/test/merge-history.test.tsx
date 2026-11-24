// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { MergeHistory, duration } from "../src/pages/MergeHistory";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c-mh", name: "App Co", mission: null, paused: false, agents: [] };
const row = (n: number, result: string, bounces: number, extra = {}) => ({
  ticketId: `t${n}`, ref: `APP-${n}`, title: `Ticket ${n}`, result, queuedAt: "2026-11-20T10:00:00.000Z", endedAt: "2026-11-20T10:30:00.000Z",
  totalMs: result === "landed" ? 1_800_000 : null, slotWaitMs: 300_000, checkMs: 600_000, ranOn: "worker-a", ciWaitMs: null, bounceReason: null, firstFailingLine: null, bounces, ...extra,
});
const data = {
  days: 14,
  perDay: [{ day: "2026-11-20", landed: 3, bounced: 2, medianMs: 1_800_000 }],
  rows: [
    row(1, "landed", 0), row(2, "landed", 2), row(3, "bounced", 2, { firstFailingLine: "test/foo.test.ts failed" }),
    row(4, "bounced", 2, { firstFailingLine: "step typecheck failed" }), row(5, "cancelled", 0),
  ],
};

const shown = () => [1, 2, 3, 4, 5].filter((n) => screen.queryByRole("link", { name: new RegExp(`Ticket ${n}$`) }));

describe("Merge history page (BOS-2379)", () => {
  it("lists the merges with their facts, a per-day line, and narrows by result and by repeat bounces", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })));
    render(<MergeHistory companies={[company]} companyId="c-mh" />);
    await screen.findByRole("link", { name: /Ticket 1$/ });
    expect(shown()).toEqual([1, 2, 3, 4, 5]);
    expect(screen.getByText(/2026-11-20: 3 landed, 2 bounced, median 30m/)).toBeTruthy();
    expect(screen.getByText("test/foo.test.ts failed")).toBeTruthy();
    expect(screen.getAllByText(/10m on worker-a/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("combobox", { name: "Result" }), { target: { value: "bounced" } });
    expect(shown()).toEqual([3, 4]);
    fireEvent.change(screen.getByRole("combobox", { name: "Result" }), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /bounced more than once/ }));
    expect(shown()).toEqual([2, 3, 4]);
  });

  it("formats durations", () => {
    expect([duration(null), duration(45_000), duration(720_000), duration(4_800_000)]).toEqual(["-", "45s", "12m", "1h 20m"]);
  });
});
