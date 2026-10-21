// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("Check again", () => {
  it("shows the countdown and note, and Edit saves the new time and note", async () => {
    const at = new Date(Date.now() + 50 * 60_000 + 30_000).toISOString();
    const ticket = { id: "t1", title: "Ship it", systemState: "in_progress", risk: "medium", repoUrl: null, defaultBranch: "main", landing: "merge", projectId: "p1", project: "App", companyId: "c1", assignee: "Engineer", assigneeAgentId: "a1", createdAt: at, lastActivityAt: at, monitorAt: at, monitorNote: "CI on the PR", monitorAttempts: 1, monitorMax: 5 };
    const puts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/tickets/t1/monitor" && init?.method === "PUT") {
          puts.push(JSON.parse(init.body as string));
          return json({});
        }
        if (url === "/api/tickets/t1") return json(ticket);
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json({});
      }),
    );
    render(<Ticket id="t1" companies={[company]} />);
    expect(await screen.findByText(/In 51m · .* · check 2 of 5/)).toBeTruthy();
    expect(screen.getByText("CI on the PR")).toBeTruthy();
    const row = within(screen.getByText("CI on the PR").closest("dd")!);
    fireEvent.click(row.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Check again at"), { target: { value: "2030-01-02T09:30" } });
    fireEvent.change(screen.getByLabelText("What to re-check"), { target: { value: "The deploy" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ at: new Date("2030-01-02T09:30").toISOString(), note: "The deploy" });
  });
});
