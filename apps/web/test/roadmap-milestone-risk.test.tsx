// @vitest-environment jsdom
// BOS-2581: "CEO manages at risk" on the Timeline tab. Off by default, a second press before it costs a CEO run, saved on the
// milestone; and "for all" covers every milestone of the company, showing the extra-CEO-runs warning before it applies.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, RoadmapMilestone } from "../src/api";
import { Roadmap } from "../src/pages/Roadmap";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

const milestone = (over: Partial<RoadmapMilestone> = {}): RoadmapMilestone => ({
  id: "m1",
  title: "Launch",
  targetDate: "2026-11-20",
  total: 3,
  done: 1,
  blocked: 0,
  active: 1,
  status: "at_risk",
  reason: "At risk: at its pace the unbuilt work finishes about Sat 5 Dec, 15 days after its date.",
  reasonTickets: [],
  horizon: "now",
  pinned: null,
  forecast: { pointsDone: 4, pointsLeft: 8, unsized: 0, pace: 2, expectedFinish: "2026-12-05", daysLate: 15 },
  finishedAt: null,
  ceoManagesRisk: false,
  ...over,
});

function stub(opts: { on?: boolean; onForAll?: boolean } = {}) {
  const ms = [milestone({ id: "m1", title: "Launch", ceoManagesRisk: !!opts.on }), milestone({ id: "m2", title: "Beta", targetDate: "2026-12-20", ceoManagesRisk: !!opts.onForAll })];
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("/api/roadmap/features")) return json([]);
      if (String(url).includes("/api/roadmap")) return json([{ id: "c1", name: "App Co", objectives: [{ id: "o1", title: "Ship it", priority: 1, status: "active", keyResults: [], milestones: ms }] }]);
      return json({});
    }),
  );
  return calls;
}

const row = (title: string) => screen.getByText(title).closest("li") as HTMLElement;

describe("CEO manages at risk (BOS-2581)", () => {
  it("is off by default, and turning it on takes a second press before it costs a CEO run", async () => {
    const calls = stub();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    const r = await waitFor(() => row("Launch"));
    expect(within(r).getByRole("button", { name: "CEO manages At risk" })).toBeTruthy();
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    fireEvent.click(within(r).getByRole("button", { name: "CEO manages At risk" }));
    // The cost warning comes first; nothing is saved yet.
    expect(within(r).getByText(/costs a CEO run/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    fireEvent.click(within(r).getByRole("button", { name: "Turn it on" }));
    // The browser's own yes/no, too, before the CEO is committed to a run.
    expect(confirm).toHaveBeenCalled();
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain("/api/milestones/m1");
    expect(patch.body).toEqual({ ceoManagesRisk: true });
  });

  it("Keep it off saves nothing, and an already-on milestone offers to turn it off", async () => {
    const calls = stub({ on: true });
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    const on = await waitFor(() => row("Launch"));
    expect(within(on).getByText(/costs a CEO run/)).toBeTruthy();
    fireEvent.click(within(on).getByRole("button", { name: "Turn it off" }));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ ceoManagesRisk: false });

    calls.length = 0;
    cleanup();
    stub();
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    const off = await waitFor(() => row("Launch"));
    fireEvent.click(within(off).getByRole("button", { name: "CEO manages At risk" }));
    fireEvent.click(within(off).getByRole("button", { name: "Keep it off" }));
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    expect(within(off).getByRole("button", { name: "CEO manages At risk" })).toBeTruthy();
  });

  it("for all shows the extra-CEO-runs warning first, then sets every milestone at once", async () => {
    const calls = stub();
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await waitFor(() => row("Launch"));
    const all = screen.getByRole("button", { name: "CEO manages At risk for all" });
    fireEvent.click(all);
    expect(screen.getByText(/Turn this on for all 2 milestones\?/)).toBeTruthy();
    expect(screen.getByText(/costs a CEO run/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Turn it on for all" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain("/api/companies/c1/milestones/ceo-manages-risk");
    expect(post.body).toEqual({ on: true });
  });

  it("BOS-2627: the CEO's plan shows under the milestone's reason line, and nothing shows when there is none", async () => {
    const calls = stub();
    const planned = milestone({ id: "m1", title: "Launch", ceoManagesRisk: true, ceoPlan: "Move the two unbuilt tickets to Zippy on Monday." });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
        if (String(url).includes("/api/roadmap/features")) return json([]);
        if (String(url).includes("/api/roadmap")) return json([{ id: "c1", name: "App Co", objectives: [{ id: "o1", title: "Ship it", priority: 1, status: "active", keyResults: [], milestones: [planned, milestone({ id: "m2", title: "Beta" })] }] }]);
        return json({});
      }),
    );
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    const r = await waitFor(() => row("Launch"));
    const reason = within(r).getByTestId("rm-reason");
    const plan = within(r).getByTestId("rm-plan");
    expect(plan.textContent).toContain("Move the two unbuilt tickets to Zippy on Monday.");
    expect(plan.textContent).toContain("CEO's plan:");
    // Under the reason line: it comes after it in the row.
    expect(reason.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A milestone with no plan has no plan line.
    expect(within(row("Beta")).queryByTestId("rm-plan")).toBeNull();
  });

  it("when every milestone is on, for all offers to turn them off", async () => {
    const calls = stub({ on: true, onForAll: true });
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    await waitFor(() => row("Launch"));
    expect(screen.getByText(/The CEO manages all 2 of these milestones/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn it off for all" }));
    expect(screen.getByText(/Turn this off for all 2 milestones\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn it off everywhere" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ on: false });
  });
});
