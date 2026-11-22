// @vitest-environment jsdom
// The Activity feed says what it is doing (BOS-2278): loading, a load error with Retry, or the
// messages, never an empty feed by mistake. The reply box keeps its draft throughout.
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
const fail = () => new Response(JSON.stringify({ error: "host timed out" }), { status: 500 });
const msg = { id: "00000000-0000-4000-8000-000000000001", author: "agent", agent: "Engineer", runId: null, text: "hello owner", delivery: null, createdAt: "2026-01-01T00:00:00.000Z" };

function server(state: { messages: "ok" | "fail" | "hang"; runs: "ok" | "fail" }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/messages")) {
        if (state.messages === "hang") return new Promise<Response>(() => {});
        return state.messages === "fail" ? fail() : json({ live: null, items: [msg] });
      }
      return state.runs === "fail" ? fail() : json([]);
    }),
  );
}

describe("ticket Activity load states (BOS-2278)", () => {
  it("says Loading the conversation while the first load is pending", () => {
    server({ messages: "hang", runs: "ok" });
    render(<TicketActivity ticketId="t-hang" assignee="Engineer" />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText(/No activity yet/)).toBeNull();
  });

  it("shows a load error with Retry, and Retry loads the messages", async () => {
    const state = { messages: "fail" as "ok" | "fail", runs: "ok" as const };
    server(state);
    render(<TicketActivity ticketId="t-retry" assignee="Engineer" />);
    await screen.findByText(/Couldn't load the conversation/);
    expect(screen.queryByText(/No activity yet/)).toBeNull();
    state.messages = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("hello owner");
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("shows the messages plus a runs error line when only the runs fail", async () => {
    server({ messages: "ok", runs: "fail" });
    render(<TicketActivity ticketId="t-runs" assignee="Engineer" />);
    await screen.findByText("hello owner");
    await screen.findByText(/Couldn't load the runs/);
  });

  it("keeps the draft in the reply box while the conversation failed", async () => {
    server({ messages: "fail", runs: "ok" });
    render(<TicketActivity ticketId="t-draft" assignee="Engineer" />);
    await screen.findByText(/Couldn't load the conversation/);
    const box = screen.getAllByRole("textbox")[0] as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "my draft" } });
    await waitFor(() => expect((screen.getAllByRole("textbox")[0] as HTMLTextAreaElement).value).toBe("my draft"));
  });
});
