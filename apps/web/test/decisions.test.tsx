// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "budget",
  question: "App Co has used 92% of its $60 budget. Raise it?",
  options: ["Raise to $80", "Keep $60"],
  recommendedOption: "Raise to $80",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "CEO",
  blocks: [{ id: "t1", title: "Checkout error states" }],
  score: 52.4,
  parts: { blocking: 30, urgency: 12, age: 10.4, liveRun: 0 },
  reasons: ["Waiting 40 min"],
  dueDate: null,
  ...over,
});

describe("decision queue", () => {
  it("shows the score, what it blocks and the recommendation, and answers with one click", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const onAnswered = vi.fn();
    render(<Decisions decisions={[decision()]} companies={[company]} loaded agentsWorking={0} onAnswered={onAnswered} />);

    expect(screen.getByRole("heading", { name: "App Co has used 92% of its $60 budget. Raise it?" })).toBeTruthy();
    expect(screen.getByLabelText("Score 52")).toBeTruthy();
    expect(screen.getByText('Blocks "Checkout error states"')).toBeTruthy();
    expect(screen.getByText("Score 52: 30 for the tasks it blocks + 12 for being due soon + 10.4 for waiting.")).toBeTruthy();
    expect(screen.getByText(/what it holds up: tasks it blocks, or 5 when an agent is paused/)).toBeTruthy();
    expect(screen.getByText("1 decision waiting across all companies, ranked by what they unblock.", { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raise to $80" }));
    await waitFor(() => expect(screen.getByText("Answered: Raise to $80.")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("/api/decisions/d1/answer", expect.objectContaining({ method: "POST", body: JSON.stringify({ answer: "Raise to $80" }) }));
    expect(onAnswered).toHaveBeenCalled();
  });

  it("explains a paused agent's score", () => {
    render(<Decisions decisions={[decision({ score: 5, parts: { blocking: 0, urgency: 0, age: 0, liveRun: 5 } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText("Score 5: 5 for a paused agent + 0 for waiting.")).toBeTruthy();
  });

  it("says why an answer was refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_answer", message: "That ticket is already done." }), { status: 422 })));
    render(<Decisions decisions={[decision()]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep $60" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That ticket is already done.");
  });

  it("is empty with the right illustration: done when idle, busy while agents work", () => {
    const { rerender } = render(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByRole("img", { name: "Nothing needs you" })).toBeTruthy();
    rerender(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={2} onAnswered={() => {}} />);
    expect(screen.getByRole("img", { name: "Agents at work, nothing needs you" })).toBeTruthy();
    expect(screen.getByText(/2 agents are working/)).toBeTruthy();
  });

  it("shows the evidence on a stalled run and what each button does", async () => {
    const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const evidence = {
      runId: "r1",
      agent: "CEO",
      ticketId: "t1",
      ticket: "Checkout error states",
      startedAt: ago(40),
      lastEventAt: ago(14),
      lastStep: { seq: 3, type: "run.update", at: ago(14), event: { update: { kind: "tool_call", title: "Run npm test", status: "in_progress" } } },
      runner: { connected: false, lastSeenAt: ago(20) },
      waitingOnOwner: false,
    };
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({ seq: n, type: "run.update", at: ago(30 - n), event: { update: { kind: "tool_call", title: `Step ${n}`, status: "done" } } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ run: { id: "r1", endedAt: null }, items, next: 6, more: false }), { status: 200 })));
    render(
      <Decisions
        decisions={[decision({ kind: "stalled_run", question: "CEO has sent nothing for 14 minutes.", options: ["Keep waiting", "Cancel run"], recommendedOption: "Keep waiting", evidence })]}
        companies={[company]}
        loaded
        agentsWorking={0}
        onAnswered={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "Checkout error states" }).getAttribute("href")).toBe("#/tickets/t1");
    expect(screen.getByText("Last activity 14 minutes ago: Run npm test in_progress")).toBeTruthy();
    expect(screen.getByText("Runner: offline since", { exact: false })).toBeTruthy();
    expect(screen.getByText("It is not waiting on you.")).toBeTruthy();
    expect(screen.getByText("Cancel run: stops it; message the agent on the task to start again.")).toBeTruthy();
    expect(screen.getByText("Keep waiting: you'll be asked again in 30 minutes if it stays quiet.")).toBeTruthy();
    expect((await screen.findByRole("link", { name: "See the whole run" })).getAttribute("href")).toBe("#/runs/r1");
    expect(screen.queryByText("Step 1")).toBeNull();
    expect(screen.getByText("Step 6")).toBeTruthy();
  });

  it("says when a stalled run never gave a sign of life", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ run: { id: "r1", endedAt: null }, items: [], next: 0, more: false }), { status: 200 })));
    const evidence = { runId: "r1", agent: "CEO", ticketId: null, ticket: null, startedAt: new Date().toISOString(), lastEventAt: null, lastStep: null, runner: { connected: true, lastSeenAt: null }, waitingOnOwner: true };
    render(<Decisions decisions={[decision({ kind: "stalled_run", options: ["Cancel run"], evidence })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText("No sign of life since it was sent to the runner.")).toBeTruthy();
    expect(screen.getByText("Runner: connected.")).toBeTruthy();
    expect(screen.getByText("It is waiting on you for a permission answer.")).toBeTruthy();
  });
});
