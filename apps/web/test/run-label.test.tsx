// @vitest-environment jsdom
// A run with no ticket says what it was doing on the dashboard and in the runs list (BOS-118),
// and the label opens the run; agent-written text is escaped.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, RunRow } from "../src/api";
import { Dashboard } from "../src/pages/Dashboard";
import { Runs } from "../src/pages/Runs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: "run-1",
  companyId: "co-1",
  agent: "Adversarial Reviewer",
  agentId: "a-1",
  ticketId: null,
  ticket: null,
  model: null,
  startedAt: "2026-10-27T10:00:00Z",
  endedAt: "2026-10-27T10:05:00Z",
  outcome: "end_turn",
  purpose: null,
  reason: null,
  note: null,
  ...over,
});

const companies = [{ id: "co-1", name: "App Co", agents: [] } as unknown as Company];

function dashboard(r: RunRow) {
  return {
    agents: [{ id: "a-1", name: "Adversarial Reviewer", role: "worker", paused: false, duty: null, run: { ...r, result: "succeeded" } }],
    stats: { agents: 1, running: 0, paused: 0, inProgress: 0, inReview: 0, open: 0, blocked: 0, decisionsWaiting: 0, monthCostMicros: 0, monthSubscriptionTokens: { input: 0, output: 0 }, monthSubscriptionRuns: 0, monthSubscriptionUnrecorded: 0 },
    runsByDay: [],
    ticketsByDay: [],
    recentTickets: [],
    recentActivity: [],
  };
}

function stub(dash: unknown, runs: RunRow[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/dashboard")) return json(dash);
      if (url.includes("/api/runs")) return json(runs);
      return json({});
    }),
  );
}

describe("what a run without a ticket was doing (BOS-118)", () => {
  it("a card says who nudged it and why, and never 'Work with no task'", async () => {
    stub(dashboard(run({ origin: "nudge", originFrom: "CEO", originNote: "re-check the add-a-skill build" })), []);
    render(<Dashboard company={companies[0]} />);
    const label = await screen.findByText("Nudged by CEO: re-check the add-a-skill build");
    expect(label.closest("a")!.getAttribute("href")).toBe("#/runs/run-1");
    expect(screen.queryByText("Work with no task")).toBeNull();
  });

  it("a scheduled sweep and a decision say so", async () => {
    stub(dashboard(run({ origin: "wiki upkeep" })), []);
    const { unmount } = render(<Dashboard company={companies[0]} />);
    expect(await screen.findByText("Wiki sweep (scheduled)")).toBeTruthy();
    unmount();
    stub(dashboard(run({ origin: "decision" })), []);
    render(<Dashboard company={companies[0]} />);
    expect(await screen.findByText("Answering a decision")).toBeTruthy();
  });

  it("falls back honestly when nothing recorded the reason", async () => {
    stub(dashboard(run()), []);
    render(<Dashboard company={companies[0]} />);
    expect(await screen.findByText("Run without a ticket (reason not recorded)")).toBeTruthy();
  });

  it("shows the same label in the runs list, and links the ticket a nudge named", async () => {
    stub(dashboard(run()), [run({ origin: "nudge", originFrom: "CEO", originNote: "take the build on", runTicketId: "t-9", endedAt: null, outcome: null })]);
    render(<Runs companies={companies} />);
    // The polls repeat the row; each one carries the same label.
    const labels = await screen.findAllByText("Nudged by CEO: take the build on");
    for (const label of labels) expect(label.closest("a")!.getAttribute("href")).toBe("#/runs/run-1");
    for (const link of screen.getAllByText("its ticket")) expect(link.getAttribute("href")).toBe("#/tickets/t-9");
  });

  it("shows the ticket a run is on as the headline, with why it was woken as a smaller line (BOS-254)", async () => {
    stub(dashboard(run()), [run({ ticketId: "t-1", ticket: "Funding layout", reason: "checking an old card", startedAt: new Date().toISOString(), endedAt: null, outcome: null })]);
    render(<Runs companies={companies} />);
    const ticketLinks = await screen.findAllByText("Funding layout");
    for (const link of ticketLinks) expect(link.closest("a")!.getAttribute("href")).toBe("#/tickets/t-1");
    for (const detail of screen.getAllByText(/woken by: Checking an old card/)) expect(detail).toBeTruthy();
  });

  it("escapes a nudge.s reason, which an agent wrote", async () => {
    stub(dashboard(run({ origin: "nudge", originFrom: "CEO", originNote: "<img src=x onerror=alert(1)> ok" })), []);
    const { container } = render(<Dashboard company={companies[0]} />);
    await screen.findByText("Nudged by CEO: <img src=x onerror=alert(1)> ok");
    expect(container.querySelector("img")).toBeNull();
  });
});
