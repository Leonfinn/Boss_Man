// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrumMasterLog } from "../src/components/ScrumMasterLog";
import { ScrumMasterSummary, summarizeActions } from "../src/components/ScrumMasterSummary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const now = new Date("2026-11-23T12:00:00Z");
const mk = (id: string, over: Record<string, unknown>) => ({ id, kind: "nudge", ticketId: "t" + id, reason: "r", actorName: "Scrum Master", createdAt: "2026-11-22T10:00:00Z", undoable: false, undoneAt: null, after: null, ...over }) as never;
const acts = [
  mk("1", { ticketRef: "BOS-1", targetName: "Penfold" }),
  mk("2", { ticketRef: "BOS-1", targetName: "Penfold", undoneAt: "2026-11-22T11:00:00Z" }),
  mk("3", { ticketRef: "BOS-2", targetName: "Kit" }),
  mk("4", { ticketRef: "BOS-3", createdAt: "2026-11-01T10:00:00Z" }),
];

describe("Scrum Master summary", () => {
  it("counts only the last 7 days: kinds, top tickets, top agents, undone share", () => {
    const s = summarizeActions(acts, now);
    expect(s.total).toBe(3);
    expect(s.tickets.map((t) => [t.ref, t.count])).toEqual([["BOS-1", 2], ["BOS-2", 1]]);
    expect(s.agents.map((a) => [a.name, a.count])).toEqual([["Penfold", 2], ["Kit", 1]]);
    expect(s.undone).toBe(1);
    expect(s.partialBack).toBeNull();
  });

  it("says so when a full page doesn't reach back 7 days", () => {
    const s = summarizeActions(acts, now, 3);
    expect(s.partialBack).toBeNull(); // oldest is older than 7 days
    expect(summarizeActions(acts.slice(0, 3), now, 3).partialBack).toBe("2026-11-22T10:00:00Z");
  });

  it("renders the fold open with the undone share, and only on the full page", async () => {
    render(<ScrumMasterSummary actions={acts} now={now} />);
    expect(screen.getByText("1 undone by you (33% of all actions)")).toBeTruthy();
    expect((screen.getByText("Last 7 days").closest("details") as HTMLDetailsElement).open).toBe(true);
    cleanup();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify([mk("1", { ticketRef: "BOS-1", createdAt: new Date().toISOString() })]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ScrumMasterLog companyId="c1" filterable summary />);
    await screen.findByText("Last 7 days");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("limit=500");
    cleanup();
    render(<ScrumMasterLog companyId="c1" filterable />);
    await screen.findByLabelText("Filter");
    expect(screen.queryByText("Last 7 days")).toBeNull();
  });
});
