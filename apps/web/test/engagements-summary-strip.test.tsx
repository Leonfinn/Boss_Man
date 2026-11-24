// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EngagementSummaryStrip, stateAge } from "../src/pages/Engagements";

// BOS-2427: the strip above the engagements list, and each row's age in its state.

afterEach(cleanup);
const NOW = Date.parse("2026-11-24T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe("stateAge", () => {
  it("says who is waited on and for how many days, marked from 3 days", () => {
    expect(stateAge("requested", ago(3), NOW)).toEqual({ text: "waiting on provider 3 d", stale: true });
    expect(stateAge("delivered", ago(2.9), NOW)).toEqual({ text: "waiting on requester 2 d", stale: false });
  });
  it("never marks a finished engagement, and shows nothing without a date", () => {
    expect(stateAge("signed_off", ago(10), NOW)).toEqual({ text: "signed off 10 d", stale: false });
    expect(stateAge("requested", undefined, NOW)).toBeNull();
  });
});

describe("EngagementSummaryStrip", () => {
  const base = { openByState: { requested: 2, delivered: 1 }, waitingOnRequester: 1, waitingOnProvider: 2, waitingOnOther: 0, spend30dPlanUseUsd: 1.5, spend30dPayAsYouGoUsd: 4, medianDaysToFinish: 2.5, finishedCount: 3 };
  it("shows the four figures, plan use and pay-as-you-go apart", () => {
    const { container } = render(<EngagementSummaryStrip s={base} />);
    const t = container.textContent!;
    expect(t).toContain("3 · 2 requested, 1 delivered");
    expect(t).toContain("1 requester, 2 provider");
    expect(t).toContain("$4.00 pay-as-you-go");
    expect(t).toContain("$1.50 plan use");
    expect(t).toContain("2.5 days");
    expect(t).not.toContain("counted as other");
  });
  it("says so when a state counts as other, and when nothing has finished", () => {
    const { container } = render(<EngagementSummaryStrip s={{ ...base, waitingOnOther: 1, medianDaysToFinish: null, finishedCount: 0 }} />);
    expect(container.textContent).toContain("1 counted as other");
    expect(container.textContent).toContain("No finished engagements yet");
  });
});
