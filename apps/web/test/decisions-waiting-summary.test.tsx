// @vitest-environment jsdom
// BOS-2434: a "Waiting for you" summary above the open cards (count by kind, the oldest card), a kind link that narrows
// the list, and an "Oldest first" order, both kept in the page address.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions, queueViewHref, readQueueView, waitingSummary } from "../src/pages/Decisions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const DAY = 86_400_000;
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
const cards = (): Decision[] => [
  decision({ id: "a", kind: "permission", question: "Run the build?", createdAt: new Date(Date.now() - 1 * DAY).toISOString() }),
  decision({ id: "b", kind: "permission", question: "Delete the temp folder?", createdAt: new Date(Date.now() - 3 * DAY).toISOString() }),
  decision({ id: "c", kind: "question", question: "Which logo?", createdAt: new Date(Date.now() - 2 * DAY).toISOString() }),
  decision({ id: "w", kind: "question", question: "Held by the team", waiting: "With the CEO", createdAt: new Date(Date.now() - 9 * DAY).toISOString() }),
];
const stub = () => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
const show = () => render(<Decisions decisions={cards()} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
const order = () => [...document.querySelectorAll("ol.queue > li")].map((li) => li.id);

describe("waiting summary (BOS-2434)", () => {
  it("counts by kind, names the oldest, and leaves out cards the team holds", () => {
    const s = waitingSummary(cards().filter((d) => !d.waiting));
    expect(s.total).toBe(3);
    expect(s.kinds.map((k) => `${k.count} ${k.label}`)).toEqual(["2 Permission", "1 Question"]);
    expect(s.oldest).toMatchObject({ id: "b", waited: "3d" });
  });

  it("renders the summary and lists newest-first by default", () => {
    stub();
    show();
    const box = screen.getByTestId("waiting-summary");
    expect(box.textContent).toContain("3 waiting for you");
    expect(within(box).getByText("2 permission")).toBeTruthy();
    expect(box.textContent).toContain("oldest: Permission, waiting 3d");
    expect(order()).toEqual(["decision-a", "decision-b", "decision-c"]);
  });

  it("the address narrows to a kind and flips the order; Show all clears the kind", () => {
    stub();
    window.location.hash = "#/decisions?kind=permission&order=oldest";
    show();
    expect(order()).toEqual(["decision-b", "decision-a"]);
    const box = screen.getByTestId("waiting-summary");
    expect(within(box).getByText("Show all").getAttribute("href")).toBe("#/decisions?order=oldest");
    expect(within(box).getByText("1 question").getAttribute("href")).toBe("#/decisions?kind=question&order=oldest");
  });

  it("clicking the oldest card's title scrolls to it; with no open cards there is no summary", async () => {
    stub();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    show();
    fireEvent.click(within(screen.getByTestId("waiting-summary")).getByText("Permission"));
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.instances[0]).toBe(document.getElementById("decision-b"));
    cleanup();
    render(<Decisions decisions={[]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />);
    expect(screen.queryByTestId("waiting-summary")).toBeNull();
  });

  it("round-trips the address", () => {
    expect(readQueueView(new URLSearchParams("kind=signoff&order=oldest"))).toEqual({ kind: "signoff", oldestFirst: true });
    expect(queueViewHref({ kind: null, oldestFirst: false })).toBe("#/decisions");
  });
});
