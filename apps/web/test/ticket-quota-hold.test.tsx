// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Ticket } from "../src/pages/Ticket";

Element.prototype.scrollIntoView = () => {};
// jsdom has no matchMedia; a fine pointer is what a desktop reports (BOS-471 uses it for phone ordering).
vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const at = new Date(Date.now() + 60 * 60_000).toISOString();
// 7 Nov 14:00 UTC, the reset the ticket quotes.
const resets = "2026-11-07T14:00:00.000Z";

function stub(ticket: Record<string, unknown>, ranNow: string[], patched: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tickets/t1/run-now" && init?.method === "POST") {
        ranNow.push(url);
        return json({ released: 1 });
      }
      if (url === "/api/tickets/t1" && init?.method === "PATCH") {
        patched.push(JSON.parse(String(init.body)));
        return json(ticket);
      }
      if (url === "/api/tickets/t1") return json(ticket);
      if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
      if (url.includes("/features")) return json({ features: [] });
      if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
      if (url.includes("/messages")) return json({ live: null, items: [] });
      return json({});
    }),
  );
}

const base = {
  id: "t1",
  title: "Fix the login page",
  risk: "medium",
  repoUrl: null,
  defaultBranch: "main",
  landing: "merge",
  projectId: "p1",
  project: "App",
  companyId: "c1",
  assignee: "Penfold",
  assigneeAgentId: "a1",
  createdAt: at,
  lastActivityAt: at,
};

describe("the quota hold on a ticket (BOS-253, BOS-471)", () => {
  it("names the agent, the account, what is paused and the reset time in plain words", async () => {
    stub(
      { ...base, systemState: "ready", quotaHeldUntil: resets, quotaHeldReason: "subscription seven_day window nearly used up", quotaHeldSource: "Claude Max", quotaHeldAgent: false },
      [],
    );
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText("Penfold is paused until Sat 7 Nov, 14:00 UTC.")).toBeTruthy();
    expect(screen.getByText(/Penfold is paid from Claude Max, whose weekly allowance is nearly used up\./)).toBeTruthy();
    expect(screen.getByText(/Boss Man pauses their routine work until it resets on Sat 7 Nov, 14:00 UTC\./)).toBeTruthy();
    expect(screen.getByText(/Run this one now, mark it urgent, or move Penfold to another account in Agents\./)).toBeTruthy();
    // Never the old vague line on a ticket that is not held by another task.
    expect(screen.queryByText(/held by other work/)).toBeNull();
  });

  it("says which ticket holds the agent only when one really does", async () => {
    stub(
      {
        ...base,
        systemState: "ready",
        quotaHeldUntil: resets,
        quotaHeldReason: "subscription seven_day window nearly used up",
        quotaHeldSource: "Claude Max",
        quotaHeldAgent: true,
        quotaHeldOther: { ref: "BOS-7", title: "Ship the dashboard" },
      },
      [],
    );
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText("Penfold is held by BOS-7.")).toBeTruthy();
    expect(screen.getByText(/BOS-7 \(Ship the dashboard\) is the work that holds them\./)).toBeTruthy();
    expect(screen.queryByText(/held by other work/)).toBeNull();
  });

  it("still offers Run now and Mark urgent on a ticket that really waits for its agent", async () => {
    const ranNow: string[] = [];
    const patched: unknown[] = [];
    stub({ ...base, systemState: "ready", quotaHeldUntil: resets, quotaHeldReason: "subscription seven_day window nearly used up", quotaHeldSource: "Claude Max" }, ranNow, patched);
    render(<Ticket id="t1" companies={[company]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(ranNow).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Mark urgent" }));
    await waitFor(() => expect(patched).toEqual([{ urgent: true }]));
  });

  it("shows no hold banner on a finished ticket", async () => {
    stub({ ...base, systemState: "done", quotaHeldUntil: resets, quotaHeldReason: "subscription seven_day window nearly used up", quotaHeldSource: "Claude Max" }, []);
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText("Fix the login page", { selector: "h1" })).toBeTruthy();
    expect(screen.queryByText(/Routine work is held/)).toBeNull();
    expect(screen.queryByText(/is paused until/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  });

  it("shows no hold banner on a ticket in review, even with the hold fields set", async () => {
    stub({ ...base, systemState: "review", quotaHeldUntil: resets, quotaHeldReason: "subscription seven_day window nearly used up", quotaHeldSource: "Claude Max" }, []);
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText("waiting for you")).toBeTruthy();
    expect(screen.queryByText(/is paused until/)).toBeNull();
    expect(screen.queryByText(/held by other work/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  });

  it("shows no hold notice or Run now when nothing is held", async () => {
    stub({ ...base, systemState: "ready" }, []);
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText("Fix the login page", { selector: "h1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
    expect(screen.queryByText(/Routine work is held/)).toBeNull();
  });
});
