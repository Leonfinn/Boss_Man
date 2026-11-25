// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";

// BOS-2578 wiring: the real Board (strip, "Your review" lane, each ticket card) with 3 tickets on ONE card.
// The Decisions badge figure (decisionsOpen) is passed the way App passes it.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", mission: null, paused: false, ticketPrefix: "BOS", agents: [{ id: "a1", name: "Developer", role: "worker", agentKind: "claude" }] } as unknown as Company;
const CARD = "88b936b3-0000-4000-8000-000000000001";
const ticket = (n: number, title: string, extra: Record<string, unknown> = {}) => ({
  id: `t${n}`, number: n, title, systemState: "review", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: "low", planFirst: false, plan: null, planApprovedAt: null,
  lastActivityAt: "2026-11-25T09:00:00Z", featureId: null, featureTitle: null, ...extra,
});
const onCard = (n: number, title: string) => ticket(n, title, { waitingOnOwner: true, ownerQuestion: "Shall I set up the test release?", ownerQuestionId: CARD });

function stub(tickets: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.endsWith("/board")) return json({ project: { id: "p1", companyId: "c1", name: "App" }, columns: [{ id: "c3", name: "Review", systemState: "review", wipLimit: null, tickets }] });
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
      return json([]);
    }),
  );
}
const open = (decisionsOpen?: number | null) => render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} decisionsOpen={decisionsOpen} />);

describe("Board: tickets that share one decision card (BOS-2578)", () => {
  it("3 tickets on 1 card plus 1 card with no ticket: banner, lane and each ticket say so", async () => {
    stub([onCard(974, "Cut the beta release notes"), onCard(1488, "Tag the beta build"), onCard(2271, "Publish the beta page")]);
    open(2); // the Decisions badge: the shared card and the deploy card with no ticket
    const strip = await screen.findByRole("link", { name: /1 question is waiting on you, holding 3 tasks/ });
    expect(strip.textContent).toContain("1 more question has no task: see Decisions.");
    const lane = screen.getByRole("region", { name: "Your review" });
    expect(within(lane).getByRole("heading", { name: "Your review" }).parentElement!.textContent).toContain("1");
    expect(lane.querySelector('[data-testid="owner-asks-lane-hint"]')!.textContent).toContain("1 question holds 3 tasks");
    expect(lane.querySelector('[data-testid="owner-asks-lane-hint"]')!.textContent).toContain("1 more question has no task: see Decisions.");
    const notes = [...lane.querySelectorAll('[data-testid="same-question-note"]')].map((n) => n.textContent);
    expect(notes).toEqual([
      "Same question as BOS-1488 and BOS-2271: one answer releases all three.",
      "Same question as BOS-974 and BOS-2271: one answer releases all three.",
      "Same question as BOS-974 and BOS-1488: one answer releases all three.",
    ]);
  });

  it("2 tickets on 1 card plus 1 ticketless card (2 and 2 that mean different things) is not read as 2 tasks", async () => {
    stub([onCard(974, "Cut the beta release notes"), onCard(1488, "Tag the beta build")]);
    open(2);
    const strip = await screen.findByRole("link", { name: /1 question is waiting on you, holding 2 tasks/ });
    expect(strip.textContent).toContain("1 more question has no task");
  });

  it("BOS-2582: a review no agent can take and a derived sign-off each sit on their own card: 2 tasks, badge 2, nothing left over", async () => {
    stub([
      ticket(10, "No reviewer here", { waitingOnOwner: true, noReviewer: true, waitingDecisionId: "card-noreviewer" }),
      ticket(11, "Passed every review", { waitingOnOwner: true, approvedBy: "Rex", waitingDecisionId: "card-signoff" }),
    ]);
    open(2); // the Decisions badge: one sign-off card per ticket
    const strip = await screen.findByRole("link", { name: /2 tasks are waiting on you/ });
    expect(strip.textContent).not.toContain("no task");
    expect(document.querySelector('[data-testid="owner-asks-lane-hint"]')).toBeNull();
    expect(document.querySelector('[data-testid="same-question-note"]')).toBeNull();
  });

  it("BOS-2582: if the badge had a card more than the tickets, the board says so (it can no longer be a cardless task the other way)", async () => {
    stub([ticket(10, "No reviewer here", { waitingOnOwner: true, noReviewer: true, waitingDecisionId: "card-noreviewer" })]);
    open(2);
    const strip = await screen.findByRole("link", { name: /1 task is waiting on you/ });
    expect(strip.textContent).toContain("1 more question has no task");
  });

  it("separate cards, one task each: plain wording, no same-question notes, no extra line when the badge matches", async () => {
    stub([
      ticket(1, "First", { waitingOnOwner: true, ownerQuestion: "Q1", ownerQuestionId: "card-1" }),
      ticket(2, "Second", { waitingOnOwner: true, ownerQuestion: "Q2", ownerQuestionId: "card-2" }),
    ]);
    open(2);
    const strip = await screen.findByRole("link", { name: /2 tasks are waiting on you/ });
    expect(strip.textContent).not.toContain("no task");
    expect(document.querySelector('[data-testid="same-question-note"]')).toBeNull();
    expect(document.querySelector('[data-testid="owner-asks-lane-hint"]')).toBeNull();
  });
});
