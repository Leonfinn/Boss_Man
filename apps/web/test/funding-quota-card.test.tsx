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
    const day = new Date(soon).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    expect(screen.getByText(new RegExp(`Runs out about ${day} at `))).toBeTruthy();
    expect(screen.queryByText(/own allowance/)).toBeNull();
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
    expect(windowLabel("some_new_thing").name).toBe("Some new thing limit");
    expect(windowLabel("seven_day_opus").name).not.toBe(windowLabel("seven_day_sonnet").name);
    expect(windowLabel("90_min").name).toBe("90-minute window");
  });
});

describe("Synthetic quota", () => {
  const synthetic = (q: Record<string, unknown>) => {
    // The server always sends the age, history and warnings (BOS-239); older fixtures may not.
    const providerQuota = { ageSeconds: 0, history: [], warned: [], ...q };
    const status = {
      source: { id: "s2", name: "Synthetic", kind: "subscription", provider: "synthetic" },
      credit: null,
      quota: [],
      forecasts: {},
      providerQuota,
      daily: [],
      totalSpentMicros: 0,
      coverage: "boss_man_runs_only",
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.includes("/status") ? status : url.includes("funding-sources") ? [status.source] : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    render(<Funding companies={[]} />);
  };

  it("shows requests used of the limit and when it renews", async () => {
    synthetic({ used: 123, limit: 1000, renewsAt: later });
    expect(await screen.findByText(/123 of 1,000/)).toBeTruthy();
    const day = new Date(later).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    expect(screen.getByText(new RegExp(`Renews ${day}`))).toBeTruthy();
  });

  it("shows the percent, time to renewal, the period's trend and the warnings had (BOS-239)", async () => {
    const taken = new Date(Date.now() - 10 * 60_000).toISOString();
    synthetic({
      used: 850,
      limit: 1000,
      renewsAt: later,
      ageSeconds: 120,
      history: [
        { used: 850, limit: 1000, renewsAt: later, takenAt: later },
        { used: 400, limit: 1000, renewsAt: later, takenAt: taken },
      ],
      warned: [80],
    });
    expect(await screen.findByText(/850 of 1,000 · 85%/)).toBeTruthy();
    expect(screen.getByText(/in \d+ days?|in \d+ hours?/)).toBeTruthy();
    expect(screen.getByText(/This period: 2 readings, 400 → 850 \(\+450/)).toBeTruthy();
    expect(screen.getByText(/Checked 2m ago · you've been warned at 80%/)).toBeTruthy();
  });

  it("says the quota is unknown rather than showing an error", async () => {
    synthetic({ used: null, limit: null, renewsAt: null });
    expect(await screen.findByText(/Quota unknown/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
