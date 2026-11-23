// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engagements } from "../src/pages/Engagements";
import { Skills } from "../src/pages/Skills";

// BOS-2165: the Engagements page and the Skills page's proposals show the newest 50 and load older ones on "Show older", newest first, with no repeats.

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

describe("Show older on paged lists", () => {
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
    expect(urls[0]).toBe("/api/engagements?limit=50&status=open");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(50);
    expect(container.querySelector("tbody tr")!.textContent).toContain("Job 59");
    await act(async () => { fireEvent.click(getByText("Show older")); await vi.advanceTimersByTimeAsync(50); });
    expect(urls.at(-1)).toBe(`/api/engagements?limit=50&status=open&before=${row(10).id}`);
    const titles = [...container.querySelectorAll("tbody tr a")].map((a) => a.textContent);
    expect(titles).toHaveLength(60);
    expect(titles.at(-1)).toBe("Job 0");
    expect(queryByText("Show older")).toBeNull();
  });

  it("Engagements search: typing reloads with q after a pause, Show older keeps it, and an empty result says so (BOS-2315)", async () => {
    const all = Array.from({ length: 60 }, (_, i) => row(59 - i));
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = new URL(String(input), "http://x");
        urls.push(url.pathname + url.search);
        const q = url.searchParams.get("q");
        if (q === "zzz") return json([]);
        const before = url.searchParams.get("before");
        const from = before ? all.findIndex((r) => r.id === before) + 1 : 0;
        return json(all.slice(from, from + Number(url.searchParams.get("limit"))));
      }),
    );
    const { container, getByLabelText, getByText } = render(<Engagements />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    const box = getByLabelText("Search engagements");
    expect(box.getAttribute("type")).toBe("search");
    await act(async () => { fireEvent.change(box, { target: { value: "Job" } }); await vi.advanceTimersByTimeAsync(400); });
    expect(urls.at(-1)).toBe("/api/engagements?limit=50&status=open&q=Job");
    await act(async () => { fireEvent.click(getByText("Show older")); await vi.advanceTimersByTimeAsync(50); });
    expect(urls.at(-1)).toBe(`/api/engagements?limit=50&status=open&q=Job&before=${row(10).id}`);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(60);
    await act(async () => { fireEvent.change(box, { target: { value: "zzz" } }); await vi.advanceTimersByTimeAsync(400); });
    expect(getByText('No engagements match "zzz".')).toBeTruthy();
  });

  it("Skill proposals: the first 50, then Show older loads the page before the last one shown", async () => {
    const prop = (i: number) => ({ id: row(i).id, name: `skill-${i}`, source: "draft", status: "installed", verdict: "recommend", reviewRequired: true, overridden: false, createdAt: "2026-11-01T00:00:00Z" });
    const all = Array.from({ length: 60 }, (_, i) => prop(59 - i));
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const url = new URL(String(input), "http://x");
        if (!url.pathname.endsWith("/skill-proposals")) return json([]);
        urls.push(url.pathname + url.search);
        const before = url.searchParams.get("before");
        const from = before ? all.findIndex((r) => r.id === before) + 1 : 0;
        return json(all.slice(from, from + Number(url.searchParams.get("limit"))));
      }),
    );
    const { container, getByText, queryByText } = render(<Skills company={{ id: "c1", name: "App Co", mission: null, paused: false, agents: [] }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    const panel = () => [...container.querySelectorAll('[aria-label="Skill proposals"] li')];
    expect(urls[0]).toBe("/api/companies/c1/skill-proposals?limit=50");
    expect(panel()).toHaveLength(50);
    expect(panel()[0]!.textContent).toContain("skill-59");
    await act(async () => { fireEvent.click(getByText("Show older")); await vi.advanceTimersByTimeAsync(50); });
    expect(urls.at(-1)).toBe(`/api/companies/c1/skill-proposals?limit=50&before=${row(10).id}`);
    expect(panel()).toHaveLength(60);
    expect(panel().at(-1)!.textContent).toContain("skill-0");
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
