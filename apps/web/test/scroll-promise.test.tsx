// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { TicketActivity } from "../src/components/TicketActivity";
import { ChatPage } from "../src/pages/Chat";

// Chromium 150+ returns a Promise from scroll methods. An effect that returns that Promise
// hands React a clean-up that isn't a function, and leaving the page then crashes it.
Element.prototype.scrollIntoView = () => Promise.resolve() as unknown as void;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("pages that scroll to the newest message", () => {
  it("open and close without React getting a Promise as an effect clean-up", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/chat/threads")) return json([{ id: "a1", name: "CEO", role: "ceo", duty: null, state: "idle", last: null }]);
        if (url.includes("/chat?")) return json({ agentId: "a1", state: "idle", items: [{ id: "m1", role: "assistant", text: "Hello from the CEO", createdAt: "2026-10-24T10:00:00Z" }] });
        if (url.includes("/messages")) return json({ live: null, items: [{ id: "m1", author: "agent", agent: "Engineer", runId: null, text: "Ticket reply", delivery: null, createdAt: "2026-10-24T10:00:00Z" }] });
        return json([]);
      }),
    );
    const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "CEO", role: "ceo" }] } as unknown as Company;
    const chat = render(<ChatPage companies={[company]} companyId="c1" agentId="a1" go={() => {}} onChanged={() => {}} />);
    await screen.findByText("Hello from the CEO");
    expect(() => chat.unmount()).not.toThrow();
    const activity = render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    await screen.findByText("Ticket reply");
    expect(() => activity.unmount()).not.toThrow();
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/must not return anything besides a function|is not a function/);
  });
});
