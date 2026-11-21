// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engagements } from "../src/pages/Engagements";

// BOS-2165: the Engagements page shows the newest 50 and loads older ones on "Show older", newest first, with no repeats.

const row = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `Job ${i}`, status: "requested", requester: "App Co", provider: "Homelab Co", budgetCapUsd: null });
const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Engagements Show older", () => {
  it("asks for the page before the last row shown, adds it below, and hides the button when it comes back short", async () => {
    // 60 engagements, newest (59) first: the first page is 59..10, the older page 9..0.
    const all = Array.from({ length: 60 }, (_, i) => row(59 - i));
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = new URL(String(input), "http://x");
        urls.push(url.pathname + url.search);
        const before = url.searchParams.get("before");
        const from = before ? all.findIndex((r) => r.id === before) + 1 : 0;
        return json(all.slice(from, from + Number(url.searchParams.get("limit"))));
      }),
    );
    const { container, getByText, queryByText } = render(<Engagements />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(urls[0]).toBe("/api/engagements?limit=50");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(50);
    expect(container.querySelector("tbody tr")!.textContent).toContain("Job 59");
    await act(async () => { fireEvent.click(getByText("Show older")); await vi.advanceTimersByTimeAsync(50); });
    expect(urls.at(-1)).toBe(`/api/engagements?limit=50&before=${row(10).id}`);
    const titles = [...container.querySelectorAll("tbody tr a")].map((a) => a.textContent);
    expect(titles).toHaveLength(60);
    expect(titles.at(-1)).toBe("Job 0");
    expect(queryByText("Show older")).toBeNull();
  });

  it("offers no Show older when the first page is not full", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json([row(1), row(0)])));
    const { container, queryByText } = render(<Engagements />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(queryByText("Show older")).toBeNull();
  });
});
