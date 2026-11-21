// @vitest-environment jsdom
// "Load older messages" on a ticket's conversation (BOS-2168): the server sends the newest 500
// with hasMore, and the page fetches the ones before on request and keeps them through polls.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketActivity } from "../src/components/TicketActivity";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const base = Date.UTC(2026, 0, 1);
const msg = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, author: i % 2 ? "agent" : "owner", agent: "Engineer", runId: null, text: `message ${i}`, delivery: null, createdAt: new Date(base + i * 60_000).toISOString() });

/** A fake server for a ticket with `total` messages, pages of 500 like the real one. */
function server(total: { n: number }) {
  const all = () => Array.from({ length: total.n }, (_, i) => msg(i));
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/messages") && init?.method === "POST") {
        total.n += 1;
        return json({ ok: true });
      }
      if (url.includes("/messages")) {
        const before = new URL(url, "http://x").searchParams.get("before");
        const items = all();
        const end = before ? items.findIndex((m) => m.id === before) : items.length;
        const page = items.slice(Math.max(0, end - 500), end);
        return json({ live: null, items: page, hasMore: end - 500 > 0 });
      }
      return json([]);
    }),
  );
  return calls;
}

const shown = (c: HTMLElement) => [...c.querySelectorAll(".chat-msg > p:first-child")].map((p) => p.textContent);

describe("ticket conversation: Load older messages (BOS-2168)", () => {
  it("loads the 120 messages before the newest 500, in order, and keeps them through the next poll", async () => {
    const total = { n: 620 };
    const calls = server(total);
    const { container } = render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    await screen.findByText("message 619");
    expect(shown(container)).toHaveLength(500);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("message 0");
    expect(shown(container)).toEqual(Array.from({ length: 620 }, (_, i) => `message ${i}`));
    expect(calls).toContain(`GET /api/tickets/t1/messages?before=${msg(120).id}`);
    // Nothing older is left, so the button goes.
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
    // Sending reloads the newest page, which now starts at message 121: message 120 slid out of
    // it, and the older pages must stay on screen all the same, with the new one at the bottom.
    fireEvent.change(screen.getByLabelText("Message to the agent"), { target: { value: "One more" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("message 620");
    expect(shown(container)).toEqual(Array.from({ length: 621 }, (_, i) => `message ${i}`));
  });

  it("shows no Load older button on a ticket with under 500 messages", async () => {
    server({ n: 40 });
    const { container } = render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    await screen.findByText("message 39");
    await waitFor(() => expect(shown(container)).toHaveLength(40));
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
  });
});
