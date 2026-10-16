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
    expect(screen.getByText("1 decision waiting across all companies, ranked by what they unblock.", { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raise to $80" }));
    await waitFor(() => expect(screen.getByText("Answered: Raise to $80.")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("/api/decisions/d1/answer", expect.objectContaining({ method: "POST", body: JSON.stringify({ answer: "Raise to $80" }) }));
    expect(onAnswered).toHaveBeenCalled();
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
});
