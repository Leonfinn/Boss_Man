// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { windowLabel } from "@boss-man/shared";
import { Funding } from "../src/pages/Funding";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const soon = new Date(Date.now() + 36 * 3_600_000).toISOString();
const later = new Date(Date.now() + 96 * 3_600_000).toISOString();

function stubApi(forecast: Record<string, unknown>) {
  const status = {
    source: { id: "s1", name: "Claude Max", kind: "subscription", provider: "anthropic" },
    credit: null,
    quota: [{ window: "seven_day_overage_included", utilization: 0.33, resetsAt: later, status: null, overageInUse: false }],
    forecasts: { seven_day_overage_included: { utilization: 0.33, resetsAt: later, perHour: 0.02, ...forecast } },
    daily: [],
    totalSpentMicros: 0,
    coverage: "all",
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/status") ? status : url.includes("funding-sources") ? [status.source] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

describe("quota card wording", () => {
  it("labels the Fable limit and never shows a raw key", async () => {
    stubApi({ runsOutAt: soon, beforeReset: true });
    render(<Funding companies={[]} />);
    expect(await screen.findByText("Fable (this week)")).toBeTruthy();
    expect(screen.getByText(/Fable can use up to 50% of your weekly limit/)).toBeTruthy();
    expect(screen.queryByText(/overage/i)).toBeNull();
    expect(screen.getByText(/Runs out about \w{3},? .* at /)).toBeTruthy();
  });

  it("shows the day and date for a time later today", async () => {
    stubApi({ runsOutAt: new Date(Date.now() + 3_600_000).toISOString(), beforeReset: true });
    render(<Funding companies={[]} />);
    const day = new Date(Date.now() + 3_600_000).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    expect(await screen.findByText(new RegExp(`Runs out about ${day} at `))).toBeTruthy();
  });

  it("says it won't run out when the projection is after the reset", async () => {
    stubApi({ runsOutAt: later, beforeReset: false });
    render(<Funding companies={[]} />);
    expect(await screen.findByText(/Won't run out before it resets/)).toBeTruthy();
    expect(screen.queryByText(/Runs out/)).toBeNull();
  });

  it("gives an unknown limit a readable fallback name", () => {
    expect(windowLabel("some_new_thing").name).toBe("Other limit");
    expect(windowLabel("90_min").name).toBe("90-minute window");
  });
});
