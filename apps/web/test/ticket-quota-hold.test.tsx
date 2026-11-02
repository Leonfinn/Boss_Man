// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Ticket } from "../src/pages/Ticket";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const at = new Date(Date.now() + 60 * 60_000).toISOString();

function stub(ticket: Record<string, unknown>, ranNow: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tickets/t1/run-now" && init?.method === "POST") {
        ranNow.push(url);
        return json({ released: 1 });
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

describe("the quota hold on a ticket (BOS-253)", () => {
  it("still offers Run now when the ticket's agent is held by other work, and says so", async () => {
    const ranNow: string[] = [];
    stub({ id: "t1", title: "Urgent fix", systemState: "ready", risk: "medium", repoUrl: null, defaultBranch: "main", landing: "merge", projectId: "p1", project: "App", companyId: "c1", assignee: "CEO", assigneeAgentId: "a1", createdAt: at, lastActivityAt: at, quotaHeldUntil: at, quotaHeldReason: "subscription seven_day window nearly used up", quotaHeldAgent: true }, ranNow);
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText(/its agent is held by other work/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(ranNow).toHaveLength(1));
  });

  it("shows no hold notice or Run now when nothing is held", async () => {
    stub({ id: "t1", title: "Normal work", systemState: "ready", risk: "medium", repoUrl: null, defaultBranch: "main", landing: "merge", projectId: "p1", project: "App", companyId: "c1", assignee: "CEO", assigneeAgentId: "a1", createdAt: at, lastActivityAt: at }, []);
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText("Normal work", { selector: "h1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
    expect(screen.queryByText(/Routine work is held/)).toBeNull();
  });
});
