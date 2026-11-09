// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";
import { Sidebar } from "../src/components/Sidebar";

// The Decisions badge counts only what the owner can act on now (BOS-969): not the cards folded into
// "Waiting, nothing to do yet". Both the menu badge and the page heading take their number from the
// same server figure, so the tests pin that they show it, and that a card in the waiting group cannot
// make the badge read higher than the page's own "to do".

afterEach(cleanup);

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const noop = () => {};
const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "question",
  question: "Approve the budget?",
  options: ["Yes", "No"],
  recommendedOption: "Yes",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "CEO",
  blocks: [],
  score: 0,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  ...over,
});

const sidebar = (props: { decisions?: Decision[]; decisionsTally?: { open: number; waiting: number } | null }) =>
  render(
    <Sidebar
      active="decisions"
      companies={[company]}
      current={company}
      decisions={props.decisions ?? []}
      decisionsTally={props.decisionsTally}
      unread={0}
      feedback={0}
      mergeWaiting={0}
      mergeStuck={0}
      notifications="unsupported"
      collapsed={false}
      narrow={false}
      onToggleCollapsed={noop}
      onPickCompany={noop}
      onCreateCompany={async () => {}}
      onEnableNotifications={noop}
      onLogout={noop}
    />,
  );
const decisionsLink = () => screen.getByRole("link", { name: /Decisions/ });

describe("the Decisions badge shows the server's needs-you-now count (BOS-969)", () => {
  it("shows the shared figure, not every open card on the page", () => {
    // Three cards on the page, two of them waiting: the server's count is 4.
    const cards = [decision({ id: "a" }), decision({ id: "b" }), decision({ id: "c", waiting: "Nothing to do yet: the ticket is back with an agent." })];
    sidebar({ decisions: cards, decisionsTally: { open: 4, waiting: 2 } });
    const badge = within(decisionsLink()).getByLabelText("4 waiting");
    expect(badge.textContent).toBe("4");
  });

  it("without the server figure, leaves the waiting cards out rather than showing the inflated number", () => {
    const cards = [decision({ id: "a" }), decision({ id: "b" }), decision({ id: "c", waiting: "Nothing to do yet: the ticket is back with an agent." })];
    sidebar({ decisions: cards });
    expect(within(decisionsLink()).getByLabelText("2 waiting").textContent).toBe("2");
  });

  it("shows no badge when nothing needs the owner, even with cards waiting", () => {
    sidebar({ decisions: [decision({ id: "a", waiting: "Nothing to do yet." })], decisionsTally: { open: 0, waiting: 1 } });
    expect(within(decisionsLink()).queryByLabelText(/waiting$/)).toBeNull();
  });
});

describe("the Decisions page heading uses the same count (BOS-969)", () => {
  it("says how many are to do, and the waiting group separately", async () => {
    const cards = [decision({ id: "a" }), decision({ id: "b" }), decision({ id: "c", waiting: "Nothing to do yet: the ticket is back with an agent." })];
    // The page asks the server's one function for the figures it shows; the answer is the headless test's.
    const fetch = async () => new Response(JSON.stringify({ open: 8, waiting: 4 }), { status: 200 });
    const original = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      render(<Decisions decisions={cards} companies={[company]} loaded agentsWorking={0} onAnswered={noop} tally={{ open: 8, waiting: 4 }} />);
      const head = screen.getByRole("heading", { name: "Decisions" }).parentElement!;
      expect(await within(head).findByText("8 decisions to do · 4 waiting", { exact: false })).toBeTruthy();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("shows only the to-do number when nothing is waiting", () => {
    render(<Decisions decisions={[decision({ id: "a" })]} companies={[company]} loaded agentsWorking={0} onAnswered={noop} tally={{ open: 1, waiting: 0 }} />);
    const head = screen.getByRole("heading", { name: "Decisions" }).parentElement!;
    expect(within(head).getByText(/^1 decision to do/, { exact: false }).textContent).toContain("1 decision to do");
    expect(within(head).queryByText(/waiting/, { exact: false })).toBeNull();
  });
});
