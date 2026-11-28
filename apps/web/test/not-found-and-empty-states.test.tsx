// @vitest-environment jsdom
// BOS-1125: a missing item shows one shared "not found" block; an empty chart says so; a new wiki opens the brief.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Dashboard } from "../src/pages/Dashboard";
import { Run } from "../src/pages/Run";
import { Ticket } from "../src/pages/Ticket";
import { Wiki } from "../src/pages/Wiki";

const company: Company = { id: "8c7f803d-8266-4cae-b17b-79e289142018", name: "Boss Man Co", mission: null, paused: false, agents: [] };

const days = (extra: Record<string, number> = {}) =>
  Array.from({ length: 14 }, (_, i) => ({ day: `2026-11-${String(i + 1).padStart(2, "0")}`, succeeded: 0, failed: 0, other: 0, backlog: 0, ready: 0, in_progress: 0, review: 0, blocked: 0, done: 0, ...extra }));
const dashboard = (runsByDay: unknown, ticketsByDay: unknown) => ({
  agents: [],
  stats: { agents: 0, running: 0, paused: 0, inProgress: 0, inReview: 0, open: 0, blocked: 0, decisionsWaiting: 0, monthCostMicros: 0, monthSubscriptionTokens: { input: 0, output: 0 }, monthSubscriptionRuns: 0, monthSubscriptionUnrecorded: 0 },
  runsByDay,
  ticketsByDay,
  recentTickets: [],
  recentActivity: [],
});

const stub = (handler: (url: string) => Response) => vi.stubGlobal("fetch", vi.fn(async (url: string) => handler(String(url))));
const missing = () => new Response(JSON.stringify({ message: "not found" }), { status: 404 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the shared not-found block (BOS-1125)", () => {
  it("shows a heading, a sentence and a way back for a run that no longer exists", async () => {
    stub(missing);
    render(<Run runId="gone" companies={[company]} />);
    expect(await screen.findByRole("heading", { name: "Run not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Runs" }).getAttribute("href")).toBe("#/runs");
  });

  it("does the same for a ticket", async () => {
    stub(missing);
    render(<Ticket id="gone" companies={[company]} />);
    expect(await screen.findByRole("heading", { name: "Ticket not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Tickets" }).getAttribute("href")).toBe("#/board");
  });

  it("does the same for a wiki page", async () => {
    stub((url) => (/\/wiki\/[^?]+$/.test(url) ? missing() : new Response(url.includes("semantic") ? JSON.stringify({ enabled: false }) : "[]", { status: 200 })));
    render(<Wiki companies={[company]} companyId={company.id} slug="no/such" go={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Wiki" }).getAttribute("href")).toBe(`#/wiki/${company.id}`);
  });
});

describe("empty charts (BOS-1125)", () => {
  it("say there is nothing to draw instead of showing bare axes", async () => {
    stub(() => new Response(JSON.stringify(dashboard(days(), days())), { status: 200 }));
    render(<Dashboard company={company} />);
    expect(await screen.findByText("No new tasks in the last 14 days")).toBeTruthy();
    // Run activity and Success rate share the same words.
    expect(screen.getAllByText("No runs in the last 14 days")).toHaveLength(2);
  });

  it("stay quiet when there is data", async () => {
    stub(() => new Response(JSON.stringify(dashboard(days({ succeeded: 2 }), days({ ready: 1 }))), { status: 200 }));
    render(<Dashboard company={company} />);
    await screen.findByText("Run activity");
    expect(screen.queryByText(/in the last 14 days$/)).toBeNull();
  });
});

describe("a brand-new wiki (BOS-1125)", () => {
  it("says only the brief exists and opens it on the right", async () => {
    stub((url) => {
      if (url.endsWith("/brief")) return new Response(JSON.stringify({ markdown: "Our mission." }), { status: 200 });
      return new Response(url.includes("semantic") ? JSON.stringify({ enabled: false }) : "[]", { status: 200 });
    });
    render(<Wiki companies={[company]} companyId={company.id} slug={undefined} go={() => {}} />);
    expect(await screen.findByText("No pages yet.")).toBeTruthy();
    expect(await screen.findByText("Your agents' reports, research and how-tos will appear here.")).toBeTruthy();
  });
});
