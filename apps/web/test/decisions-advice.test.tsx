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
  kind: "question",
  question: "Which one?",
  options: ["A", "B"],
  recommendedOption: "A",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "Engineer",
  blocks: [],
  score: 10,
  parts: { blocking: 0, urgency: 0, age: 10, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  ...over,
});

describe("ask the CEO for advice", () => {
  it("sends the optional note and refreshes", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onAnswered = vi.fn();
    render(<Decisions decisions={[decision()]} companies={[company]} loaded agentsWorking={0} onAnswered={onAnswered} />);
    fireEvent.click(screen.getByText("Not enough detail?"));
    fireEvent.change(screen.getByLabelText(/What's unclear/), { target: { value: "What is A?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask the CEO for advice" }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
    const [url, init] = (fetchMock.mock.calls.find((c) => (c[0] as unknown as string) === "/api/decisions/d1/ask-advice") as unknown as [string, RequestInit]);
    expect(url).toBe("/api/decisions/d1/ask-advice");
    expect(JSON.parse(init.body as string)).toEqual({ note: "What is A?" });
  });

  it("shows the ask button on a permission request and posts it", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onAnswered = vi.fn();
    render(<Decisions decisions={[decision({ kind: "permission", options: ["Allow once", "Deny"], context: { type: "permission" } })]} companies={[company]} loaded agentsWorking={0} onAnswered={onAnswered} />);
    fireEvent.click(screen.getByText("Not enough detail?"));
    fireEvent.click(screen.getByRole("button", { name: "Ask the CEO for advice" }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
    const [url] = (fetchMock.mock.calls.find((c) => (c[0] as unknown as string) === "/api/decisions/d1/ask-advice") as unknown as [string, RequestInit]);
    expect(url).toBe("/api/decisions/d1/ask-advice");
  });

  it("follows the CEO's Allow over the rule's Deny: one headline, Allow is the primary button, and the card says why (BOS-328)", () => {
    render(
      <Decisions
        decisions={[
          decision({
            kind: "permission",
            options: ["Allow once", "Deny"],
            recommendedOption: "Deny",
            context: { type: "permission", advice: { state: "advised", what: "Runs a benchmark.", needed: "Yes.", recommendation: "allow", why: "Everything stays in the checkout." } },
          }),
        ]}
        companies={[company]}
        loaded
        agentsWorking={0}
        onAnswered={() => {}}
      />,
    );
    // (BOS-1236) The recommended answer is the filled button, named "…, recommended"; there is no separate box.
    expect(document.querySelector(".rec")).toBeNull();
    expect(screen.getByRole("button", { name: "Allow once, recommended" }).className).toContain("primary");
    expect(screen.queryByRole("button", { name: "Deny, recommended" })).toBeNull();
    expect(screen.getByRole("button", { name: "Deny" }).className).not.toContain("primary");
    expect(screen.getByText(/automatic check suggested Deny, but the CEO/)).toBeTruthy();
  });

  it("shows the CEO's advice on a permission card", () => {
    render(
      <Decisions
        decisions={[
          decision({
            kind: "permission",
            options: ["Allow once", "Deny"],
            context: { type: "permission", advice: { state: "advised", what: "Copies part of a database file into another file.", needed: "No, this ticket doesn't need it.", recommendation: "deny", why: "It reads data the ticket can get another way." } },
          }),
        ]}
        companies={[company]}
        loaded
        agentsWorking={0}
        onAnswered={() => {}}
      />,
    );
    expect(screen.getByText(/The CEO's advice/)).toBeTruthy();
    expect(screen.getByText(/Copies part of a database file/)).toBeTruthy();
    expect(screen.getByText(/this ticket doesn't need it/)).toBeTruthy();
    expect(screen.getByText("Recommend Deny")).toBeTruthy();
    expect(screen.getByText(/It reads data the ticket can get another way/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask the CEO for advice" })).toBeNull();
  });

  it("shows 'CEO is looking at this' greyed but still answerable", () => {
    render(<Decisions decisions={[decision({ context: { advice: { state: "asking", note: "What is A?" } } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByRole("status").textContent).toMatch(/CEO is looking at this/);
    expect(screen.getByRole("button", { name: /^A\b/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask the CEO for advice" })).toBeNull();
  });

  it("says when the CEO didn't respond, and links a replaced decision", () => {
    render(
      <Decisions
        decisions={[decision({ context: { advice: { state: "timed_out" } } })]}
        companies={[company]}
        loaded
        agentsWorking={0}
        onAnswered={() => {}}
        advised={[{ id: "d0", companyId: "c1", question: "Old one?", advice: { state: "reissued", replacedBy: "d1" } }]}
      />,
    );
    expect(screen.getByText(/the CEO didn't respond/)).toBeTruthy();
    expect(screen.getByText(/replaced by a clearer decision/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /See the new one/ })).toBeTruthy();
  });

  it("shows the original question on a rewritten card", () => {
    render(<Decisions decisions={[decision({ question: "New wording?", context: { advice: { state: "clarified", originalQuestion: "Old wording?" } } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText("Original question (before the CEO rewrote it)")).toBeTruthy();
    expect(screen.getByText("Old wording?")).toBeTruthy();
  });
});

describe("a decision the CEO wrote to replace an unclear one", () => {
  it("says the CEO wrote it and lists its numbered steps", () => {
    render(<Decisions decisions={[decision({ context: { steps: ["Open Settings", "Click Save"], advice: { state: "replacement", replaces: "d0" } } })]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.getByText(/Written by the CEO to replace an earlier, unclear decision/)).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(expect.arrayContaining(["Open Settings", "Click Save"]));
  });
});
