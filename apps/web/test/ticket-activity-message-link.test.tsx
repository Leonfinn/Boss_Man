// @vitest-environment jsdom
// A link to one message of a ticket's conversation (BOS-2456): "Copy link" on each message, and an
// address with ?m=<id> that scrolls to the message and marks it, loading older pages when needed.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const copied: string[] = [];
vi.mock("../src/clipboard", () => ({ copyText: async (t: string) => (copied.push(t), true) }));
import { TicketActivity } from "../src/components/TicketActivity";

const scrolled: (string | null)[] = [];
Element.prototype.scrollIntoView = function (this: Element) {
  scrolled.push(this.getAttribute("data-key"));
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  copied.length = 0;
  scrolled.length = 0;
  window.location.hash = "";
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const base = Date.UTC(2026, 0, 1);
const msg = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, author: i % 2 ? "agent" : "owner", agent: "Engineer", runId: null, text: `message ${i}`, delivery: null, createdAt: new Date(base + i * 60_000).toISOString() });

function server(total: number) {
  const all = Array.from({ length: total }, (_, i) => msg(i));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/messages")) {
        const before = new URL(url, "http://x").searchParams.get("before");
        const end = before ? all.findIndex((m) => m.id === before) : all.length;
        return json({ live: null, items: all.slice(Math.max(0, end - 500), end), hasMore: end - 500 > 0 });
      }
      return json([]);
    }),
  );
}

// A deadline for slow machines (jsdom renders 500+ messages), not a speed limit.
const RENDER = { timeout: 20_000 };

describe("ticket conversation: link to one message (BOS-2456)", () => {
  it("Copy link puts the ticket address and the message id on the clipboard", async () => {
    server(3);
    render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    await screen.findByText("message 2", undefined, RENDER);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy link" })[1]!);
    await waitFor(() => expect(copied).toEqual([`${window.location.origin}${window.location.pathname}#/tickets/t1?m=${msg(1).id}`]));
    await screen.findByRole("button", { name: "Link copied" });
  });

  it("opens at a message older than the first page: loads it, scrolls to it and marks it", async () => {
    server(620);
    window.location.hash = `#/tickets/t1?m=${msg(5).id}`;
    const { container } = render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    await screen.findByText("message 5", undefined, RENDER);
    await waitFor(() => expect(scrolled).toContain(`m${msg(5).id}`), RENDER);
    const row = container.querySelector(`[data-key="m${msg(5).id}"]`)!;
    expect(row.className).toContain("found");
    expect(screen.queryByText("That message isn't in this conversation.")).toBeNull();
  }, 90_000);

  it("says so when the message is not in the conversation, and opens normally", async () => {
    server(20);
    window.location.hash = "#/tickets/t1?m=no-such-message";
    const { container } = render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    await screen.findByText("That message isn't in this conversation.", undefined, RENDER);
    expect(container.querySelector(".found")).toBeNull();
    expect(screen.getByText("message 19")).toBeTruthy();
  });
});
