// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FundingCards } from "../src/pages/Funding";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stub(weeks: unknown[], whoUsedIt?: unknown) {
  const status = {
    source: { id: "s1", name: "Claude Max", kind: "subscription", provider: "anthropic" },
    credit: null,
    quota: [],
    windowsSeen: [],
    forecasts: {},
    daily: [],
    weeks,
    whoUsedIt,
    totalSpentMicros: 0,
    coverage: "all",
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/status") ? status : url.includes("funding-sources") ? [status.source] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

const week = (i: number, extra: object = {}) => ({
  start: new Date(Date.UTC(2026, 10, 16 - i * 7)).toISOString(),
  end: new Date(Date.UTC(2026, 10, 23 - i * 7)).toISOString(),
  plans: [],
  spendMicros: 0,
  holds: [],
  ...extra,
});

describe("Who used it fold on a funding card", () => {
  it("lists agents and projects with shares, and says so when unused", async () => {
    const who = {
      days: 7,
      totalTokens: 1000,
      totalMicros: 0,
      agents: [{ id: "a", name: "Zippy", tokens: 800, costMicros: 0, share: 0.8, engagement: false }],
      agentsOthers: { tokens: 200, costMicros: 0, share: 0.2, count: 2 },
      projects: [{ id: "p", name: "Web", company: "Acme", tokens: 1000, costMicros: 0, share: 1, engagement: true }],
    };
    stub([], who);
    render(<FundingCards />);
    expect(await screen.findByText("Who used it, last 7 days")).toBeTruthy();
    expect(screen.getByText("Zippy")).toBeTruthy();
    expect(screen.getByText("Everyone else (2)")).toBeTruthy();
    expect(screen.getByText(/engagement work/)).toBeTruthy();
    // A plan-only source shows tokens and share but no money figure.
    expect(screen.getByText("800 tokens · 80%")).toBeTruthy();
    cleanup();
    stub([], { days: 7, totalTokens: 0, totalMicros: 0, agents: [], projects: [] });
    render(<FundingCards />);
    expect(await screen.findByText("Not used in the last 7 days")).toBeTruthy();
  });
});

describe("Last 8 weeks fold on a funding card", () => {
  it("is a closed details fold with a row per week: plan use at resets, spend and holds with start, end and length", async () => {
    stub([
      week(0, {
        plans: [{ window: "five_hour", resets: 4, peak: 0.92, limit: null }],
        spendMicros: 12_500_000,
        holds: [{ window: "five_hour", startedAt: "2026-11-20T10:00:00.000Z", endedAt: "2026-11-20T11:30:00.000Z", ms: 90 * 60_000 }],
      }),
      week(1),
    ]);
    render(<FundingCards />);
    const summary = await screen.findByText("Last 8 weeks");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.closest("details")!.hasAttribute("open")).toBe(false);
    expect(screen.getByText(/92% of 5-hour window, 4 resets/)).toBeTruthy();
    expect(screen.getByText(/\$12\.50 spent pay as you go/)).toBeTruthy();
    expect(screen.getByText(/Work held for the 5-hour window: .* to .* \(1h 30m\)/)).toBeTruthy();
    expect(screen.getByText("Nothing recorded")).toBeTruthy();
  });

  it("says nothing is recorded yet when every week is empty", async () => {
    stub([week(0), week(1)]);
    render(<FundingCards />);
    expect(await screen.findByText(/Nothing recorded yet/)).toBeTruthy();
  });
});
