// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Dashboard } from "../src/pages/Dashboard";
import { Ticket } from "../src/pages/Ticket";

Element.prototype.scrollIntoView = () => {};
const mm = (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", mm);
  // The first load never returns: the page must say so instead of staying blank.
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

describe("first load of the Dashboard and the ticket page", () => {
  it("Dashboard shows a loading message after the Loader's delay, not an empty page", async () => {
    const { container } = render(<Dashboard company={company} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(container.textContent).toContain("Loading the dashboard");
  });

  it("ticket page shows a loading message after the Loader's delay, not an empty page", async () => {
    const { container } = render(<Ticket id="t1" companies={[company]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(container.textContent).toContain("Loading the ticket");
  });
});
