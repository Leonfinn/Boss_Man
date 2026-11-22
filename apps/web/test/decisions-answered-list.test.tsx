// @vitest-environment jsdom
// BOS-2187: the "Answered" section reads past answers when opened, shows who and what, and pages with "Show older".
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnsweredList } from "../src/pages/Decisions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (n: number, over: Record<string, unknown> = {}) => ({ id: `d${n}`, question: `Question ${n}`, status: "answered", answer: "Stripe", by: "owner", byName: null, at: "2026-11-01T10:00:00.000Z", ticket: { id: `t${n}`, title: `Ticket ${n}`, ref: `BOS-${n}` }, ...over });
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Answered list", () => {
  it("reads nothing until opened, then shows the answer, who, and the ticket link, and Show older adds the next page", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return String(url).includes("cursor=c1") ? reply({ items: [item(2, { by: "ceo", byName: "Casey" })], next: null }) : reply({ items: [item(1)], next: "c1" });
    }));
    const { container } = render(<AnsweredList />);
    expect(calls).toHaveLength(0);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await screen.findByText("Question 1");
    expect(screen.getByText("Stripe").textContent).toBe("Stripe");
    expect(container.textContent).toContain("You");
    expect(container.querySelector('a[href="#/tickets/t1"]')).not.toBeNull();
    fireEvent.click(screen.getByText("Show older"));
    await screen.findByText("Question 2");
    expect(container.textContent).toContain("Casey");
    expect(screen.queryByText("Show older")).toBeNull();
  });

  it("says so when nothing has been answered, and shows an error when the read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ items: [], next: null })));
    const { container } = render(<AnsweredList />);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await screen.findByText("No card has been answered yet.");
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "content-type": "application/json" } })));
    const r2 = render(<AnsweredList />);
    const d2 = r2.container.querySelector("details")!;
    d2.open = true;
    fireEvent(d2, new Event("toggle"));
    await waitFor(() => expect(r2.container.querySelector('[role="alert"]')).not.toBeNull());
  });
});
