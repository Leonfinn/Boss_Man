// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("says how many are to do, and the waiting group separately, and sends no numbers of its own (BOS-996)", async () => {
    const cards = [decision({ id: "a" }), decision({ id: "b" }), decision({ id: "c", waiting: "Nothing to do yet: the ticket is back with an agent." })];
    // With no figure from the app, the page asks the server's tally for both; it sends no numbers of
    // its own, so a stale tab can't lower or raise what the server says (BOS-996).
    const asked: string[] = [];
    const fetch = async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ open: 8, waiting: 4 }), { status: 200 });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    try {
      render(<Decisions decisions={cards} companies={[company]} loaded agentsWorking={0} onAnswered={noop} />);
      const head = screen.getByRole("heading", { name: "Decisions" }).parentElement!;
      expect(await within(head).findByText("8 decisions to do · 4 waiting", { exact: false })).toBeTruthy();
      const tallyCalls = asked.filter((u) => u.includes("/api/decisions/tally"));
      expect(tallyCalls.length).toBeGreaterThan(0);
      for (const u of tallyCalls) {
        expect(u).not.toContain("open=");
        expect(u).not.toContain("waiting=");
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("drops a card the owner answers here straight out of the count until the next read", async () => {
    // The tally says 2 to do and 0 waiting; answering one here takes the heading to 1 at once, before
    // the page's next poll or the app's fresh tally arrives.
    const cards = [decision({ id: "a" }), decision({ id: "b" })];
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/api/decisions/tally") ? new Response(JSON.stringify({ open: 2, waiting: 0 }), { status: 200 }) : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const onAnswered = vi.fn();
    render(<Decisions decisions={cards} companies={[company]} loaded agentsWorking={0} onAnswered={onAnswered} tally={{ open: 2, waiting: 0 }} />);
    const head = screen.getByRole("heading", { name: "Decisions" }).parentElement!;
    expect(await within(head).findByText(/^2 decisions to do/, { exact: false })).toBeTruthy();
    // The recommended option is one click; the first card's button is the first "Yes".
    fireEvent.click(within(head.parentElement!.parentElement!).getAllByRole("button", { name: "Yes" })[0]!);
    await waitFor(() => expect(within(head).getByText(/^1 decision to do/, { exact: false })).toBeTruthy());
    expect(onAnswered).toHaveBeenCalled();
  });
  it("shows only the to-do number when nothing is waiting", () => {
    render(<Decisions decisions={[decision({ id: "a" })]} companies={[company]} loaded agentsWorking={0} onAnswered={noop} tally={{ open: 1, waiting: 0 }} />);
    const head = screen.getByRole("heading", { name: "Decisions" }).parentElement!;
    expect(within(head).getByText(/^1 decision to do/, { exact: false }).textContent).toContain("1 decision to do");
    expect(within(head).queryByText(/waiting/, { exact: false })).toBeNull();
  });
});
