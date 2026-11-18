// @vitest-environment jsdom
// BOS-1691: a card that leaves the owner's list never leaves a silent gap. A card hidden for a re-check shows a line
// in the main view (who, after what, back by when), a card closed in the last 2 hours says why outside the "Closed"
// fold, and touching a card marks it opened so a later close or re-check also tells the owner's feed.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClosedNoticeCard, Company, Decision } from "../src/api";
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
  question: "Which payment provider for the shop?",
  options: ["Stripe", "PayPal"],
  recommendedOption: "Stripe",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "CEO",
  blocks: [],
  score: 10,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  ...over,
});
const stubFetch = () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (calls.push(String(url)), new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }))));
  return calls;
};

describe("a card that leaves the list says why (BOS-1691)", () => {
  it("a card hidden for a re-check shows a line in the main view, not in the folded waiting group, and not the empty state", () => {
    stubFetch();
    const backBy = "2026-11-16T21:18:00.000Z";
    const d = decision({
      staleAt: "2026-11-16T20:18:00.000Z",
      staleReason: 'the owner answered "Sign off BOS-1641?"',
      waiting: "Being re-checked by CEO",
      rechecking: { by: "CEO", stage: "author", backBy, hidden: true },
    });
    render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    const lines = screen.getByTestId("recheck-lines");
    expect(lines.textContent).toContain("Which payment provider for the shop?");
    expect(lines.textContent).toContain('Being re-checked by CEO after you answered "Sign off BOS-1641?".');
    const hhmm = new Date(backBy).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(lines.textContent).toContain(`Back on your list by ${hhmm}`);
    expect(lines.closest("details")).toBeNull();
    expect(screen.queryByText("Nothing needs you")).toBeNull();
    expect(screen.queryByText(/Waiting, nothing to do yet/)).toBeNull();
  });

  it("a card closed in the last 2 hours says who and why outside the Closed fold", () => {
    stubFetch();
    const now = Date.now();
    const notice: ClosedNoticeCard = {
      id: "a65d0309-1111-4111-8111-111111111111",
      companyId: "c1",
      question: "Merge BOS-1641 before the sign-off?",
      context: {},
      notice: { why: "withdrawn", text: "Withdrawn by CEO on BOS-1641: the sign-off answered it. What happens instead: nothing, it is no longer needed. You don't need to do anything for this card.", at: new Date(now - 60_000).toISOString(), until: new Date(now + 3_600_000).toISOString() },
    };
    const expired = { ...notice, id: "old", question: "An old card", notice: { ...notice.notice, until: new Date(now - 1000).toISOString() } };
    render(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} closedNotices={[notice, expired]} />);
    const section = screen.getByTestId("left-your-list");
    expect(section.closest("details")).toBeNull();
    expect(section.textContent).toContain("Merge BOS-1641 before the sign-off?");
    expect(section.textContent).toContain("Withdrawn by CEO on BOS-1641: the sign-off answered it.");
    expect(section.textContent).not.toContain("An old card");
  });

  it("touching a card marks it opened, once", () => {
    const calls = stubFetch();
    render(<Decisions decisions={[decision()]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    const li = document.getElementById("decision-d1")!;
    fireEvent.pointerDown(li);
    fireEvent.pointerDown(li);
    expect(calls.filter((u) => u.endsWith("/api/decisions/d1/opened"))).toHaveLength(1);
  });
});
