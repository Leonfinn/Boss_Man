// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { windowLabel } from "@boss-man/shared";
import { Funding } from "../src/pages/Funding";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const soon = new Date(Date.now() + 36 * 3_600_000).toISOString();
const later = new Date(Date.now() + 96 * 3_600_000).toISOString();

function stubApi(forecast: Record<string, unknown>, overageInUse = false) {
  const status = {
    source: { id: "s1", name: "Claude Max", kind: "subscription", provider: "anthropic" },
    credit: null,
    quota: [{ window: "seven_day_overage_included", utilization: 0.33, resetsAt: later, status: null, overageInUse }],
    windowsSeen: ["seven_day_overage_included"],
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
  it("labels the Fable limit and shows the raw key only in the hold switches", async () => {
    stubApi({ runsOutAt: soon, beforeReset: true });
    render(<Funding companies={[]} />);
    expect(await screen.findByText("Fable (this week)")).toBeTruthy();
    expect(screen.getByText(/Fable can use up to 50% of your weekly limit/)).toBeTruthy();
    // The owner sees the adapter's own name in the switches, so it is never a guess (BOS-227).
    expect(screen.getByText("(seven_day_overage_included)")).toBeTruthy();
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

  // BOS-1012: the rate beside the date is the one the date was worked out from, one decimal under 10%.
  it("shows the rate the date was made from, with a decimal so 0.3% doesn't read as 0%", async () => {
    stubApi({ perHour: 0.0031, runsOutPerHour: 0.0045, runsOutAt: later, beforeReset: false });
    render(<Funding companies={[]} />);
    expect(await screen.findByText(/about 0\.4% an hour/)).toBeTruthy();
    expect(screen.queryByText(/about 0\.3% an hour/)).toBeNull();
  });

  it("shows a fast rate rounded to a whole percent, and warns only when it runs out before the reset", async () => {
    stubApi({ perHour: 0.123, runsOutPerHour: 0.123, runsOutAt: soon, beforeReset: true });
    render(<Funding companies={[]} />);
    expect(await screen.findByText(/about 12% an hour/)).toBeTruthy();
    expect(screen.getByText(/^Runs out about/)).toBeTruthy();
  });

  it("names each window by its raw adapter name with its latest percentage, and says when credits are in use", async () => {
    stubApi({ runsOutAt: later, beforeReset: false }, true);
    render(<Funding companies={[]} />);
    expect(await screen.findByText(/seven_day_overage_included/)).toBeTruthy();
    expect(screen.getAllByText("33%").length).toBeGreaterThan(0);
    expect(screen.getByText(/using usage credits/)).toBeTruthy();
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

  it("shows the week's credits as the measure, never the request window's 0 of 500 (BOS-260)", async () => {
    // The real response stores 5,170 of 10,000: 51.7% used, 48% left.
    synthetic({ used: 5170, limit: 10_000, renewsAt: null, measure: "weekly" });
    expect(await screen.findByText("Weekly credits")).toBeTruthy();
    expect(screen.getByText(/52% used · 48% left/)).toBeTruthy();
    expect(screen.getByText(/Credits come back 2% at a time/)).toBeTruthy();
    expect(screen.queryByText(/0 of 500/)).toBeNull();
  });

  it("labels the request window as that, and says it isn't total usage", async () => {
    synthetic({ used: 0, limit: 500, renewsAt: later, measure: "requests" });
    expect(await screen.findByText("Requests this period")).toBeTruthy();
    expect(screen.getByText(/0 of 500 · 0%/)).toBeTruthy();
    expect(screen.getByText(/Synthetic's API doesn't report weekly credits for this account, so this isn't total usage/)).toBeTruthy();
    const day = new Date(later).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    expect(screen.getByText(new RegExp(`Renews ${day}`))).toBeTruthy();
  });

  it("shows the percent, time to renewal, the period's trend and the warnings had (BOS-239)", async () => {
    const taken = new Date(Date.now() - 10 * 60_000).toISOString();
    synthetic({
      used: 850,
      limit: 1000,
      renewsAt: later,
      measure: "requests",
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
    expect(screen.getByText(/Checked 2 min ago · you've been warned at 80%/)).toBeTruthy();
  });

  // BOS-934: Synthetic spends paid top-up credit past the weekly allowance; its API doesn't report the balance.
  it("offers the top-up credit choice on a Synthetic plan, says what each does, and that the balance can't be read", async () => {
    synthetic({ used: 9932, limit: 10_000, renewsAt: null, measure: "weekly" });
    expect(await screen.findByText("I have top-up credit")).toBeTruthy();
    expect(screen.queryByText("I have extra usage")).toBeNull();
    expect(screen.getByText(/Top-up credit: not shown\. Synthetic's API doesn't report the balance/)).toBeTruthy();
    // The default holds as today, and says so.
    expect(screen.getByText(/Routine work is held at 95% of the weekly allowance and nothing spends top-up credit/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Top-up credit"), { target: { value: "all" } });
    expect(screen.getByText(/Nothing is held: once the weekly allowance is used, Synthetic pays for all work from your top-up credit/)).toBeTruthy();
    expect(screen.getByText(/Boss Man can't stop before it runs out/)).toBeTruthy();
    expect(screen.queryByText(/billed by Anthropic/)).toBeNull();
  });

  it("says the quota is unknown rather than showing an error", async () => {
    synthetic({ used: null, limit: null, renewsAt: null });
    expect(await screen.findByText(/Quota unknown/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
