// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Engagement, Engagements } from "../src/pages/Engagements";
import { Plan } from "../src/pages/Plan";

// BOS-1989: before the first load the Plan and Engagements pages show a loader, not a blank page;
// a failed Engagements list says so with Retry.

const mm = (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", mm);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const never = () => vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1300); });

describe("Plan and Engagements first load", () => {
  // First on purpose: reads of one URL are shared while in flight, so a stuck request from an
  // earlier test would answer this one too.
  it("a failed Engagements list shows the error and Retry, which loads again", async () => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })));
    vi.stubGlobal("fetch", f);
    const { container, getByText } = render(<Engagements />);
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load engagements");
    expect(container.querySelector("table")).toBeNull();
    const before = f.mock.calls.length;
    await act(async () => { fireEvent.click(getByText("Retry")); await vi.advanceTimersByTimeAsync(50); });
    expect(f.mock.calls.length).toBeGreaterThan(before);
  });

  it("Plan shows a loading message while the plan has not answered", async () => {
    never();
    const { container } = render(<Plan companies={[company]} companyId="c1" go={() => {}} />);
    await settle();
    expect(container.textContent).toContain("Loading the plan");
  });

  it("Engagements list shows a loading message, not an empty table", async () => {
    never();
    const { container } = render(<Engagements />);
    await settle();
    expect(container.textContent).toContain("Loading engagements");
    expect(container.querySelector("table")).toBeNull();
  });

  it("Engagement detail shows a loading message, not a blank page", async () => {
    never();
    const { container } = render(<Engagement id="e1" />);
    await settle();
    expect(container.textContent).toContain("Loading the engagement");
  });

});
