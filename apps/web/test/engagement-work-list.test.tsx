// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engagement } from "../src/pages/Engagements";

// BOS-2368: the engagement page lists the provider's tickets under "Work"; without them there is no section.

const mm = (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", mm);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const view = (extra: Record<string, unknown>) => ({
  id: "e-work",
  title: "Deploy v1.4",
  status: "in_progress",
  requesterCompany: "App Co",
  providerCompany: "Homelab",
  scope: "Deploy",
  deliverables: null,
  acceptanceCriteria: [],
  spentUsd: 0,
  counterTerms: null,
  delivery: null,
  thread: [],
  ...extra,
});

async function show(body: unknown, id: string) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))));
  const out = render(<Engagement id={id} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  return out;
}

const headings = (c: HTMLElement) => [...c.querySelectorAll("h2")].map((h) => h.textContent);

describe("Engagement Work section", () => {
  it("lists the tickets with state, assignee, spend and 'N of M done'", async () => {
    const { container } = await show(
      view({
        tickets: [
          { id: "t1", ref: "HOM-1", title: "Deploy step", state: "done", assignee: "Ann", spentUsd: 1.75 },
          { id: "t2", ref: "HOM-2", title: "Verify step", state: "in_progress", assignee: null, spentUsd: 0 },
        ],
      }),
      "e-work-1",
    );
    expect(headings(container)).toContain("Work");
    expect(container.textContent).toContain("1 of 2 done");
    const rows = [...container.querySelectorAll("tbody tr")].map((r) => r.textContent);
    expect(rows[0]).toContain("HOM-1");
    expect(rows[0]).toContain("done");
    expect(rows[0]).toContain("Ann");
    expect(rows[0]).toContain("$1.75");
    expect(rows[1]).toContain("in progress");
    expect(rows[1]).toContain("Unassigned");
    expect(container.querySelector('a[href="#/tickets/t1"]')).not.toBeNull();
  });

  it("shows no Work section when tickets is missing", async () => {
    const { container } = await show(view({}), "e-work-2");
    expect(container.textContent).toContain("Deploy v1.4");
    expect(headings(container)).not.toContain("Work");
  });

  it("shows no Work section when tickets is empty", async () => {
    const { container } = await show(view({ tickets: [] }), "e-work-3");
    expect(container.textContent).toContain("Deploy v1.4");
    expect(headings(container)).not.toContain("Work");
  });
});
