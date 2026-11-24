// @vitest-environment jsdom
// Find in this conversation on a ticket's Activity (BOS-2422), over the same helper chat uses (BOS-2411).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketActivity } from "../src/components/TicketActivity";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const base = Date.UTC(2026, 0, 1);
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const msg = (i: number, text: string) => ({ id: id(i), author: i === 30 ? "agent" : "owner", agent: i === 30 ? "Engineer" : null, runId: null, text, delivery: null, createdAt: new Date(base + i * 60_000).toISOString() });
// Messages 20..39 are the newest page; 0..19 are older. "needle" is in 5 (older), 25, and 26 twice.
const textOf = (i: number) => (i === 5 ? "an old needle" : i === 25 ? "Needle one" : i === 26 ? "needle and NEEDLE" : i === 30 ? "Summary\nDetails:\nthe hidden needle" : `message ${i}`);
const mk = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(from + k, textOf(from + k)));

function stub() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("before=")) return json({ live: null, items: mk(0, 20), hasMore: false });
      if (url.includes("/messages")) return json({ live: null, items: mk(20, 40), hasMore: true });
      return json([]);
    }),
  );
  return calls;
}
const open = async () => {
  const view = render(<TicketActivity ticketId="t1" assignee="Engineer" />);
  await screen.findByText("message 39");
  fireEvent.click(screen.getByRole("button", { name: "Find" }));
  return view;
};
const type = (v: string) => fireEvent.change(screen.getByLabelText("Find in this conversation"), { target: { value: v } });

describe("ticket conversation: find", () => {
  it("counts and highlights matches, steps with Next and Previous, and opens Details for a match inside them", async () => {
    stub();
    const { container } = await open();
    type("needle");
    await screen.findByText("1 of 4");
    expect(container.querySelectorAll("mark.find-hit")).toHaveLength(4);
    expect(container.querySelector("mark.current")?.textContent).toBe("Needle");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("2 of 4");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("4 of 4");
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("3 of 4");
    expect(container.querySelector("mark.current")?.textContent).toBe("NEEDLE");
  });

  it("Ctrl+F in the conversation opens the box, and Escape closes it and clears the highlights", async () => {
    stub();
    const { container } = render(<TicketActivity ticketId="t1" assignee="Engineer" />);
    await screen.findByText("message 39");
    expect(screen.queryByLabelText("Find in this conversation")).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Message to the agent"), { key: "f", ctrlKey: true });
    const box = screen.getByLabelText("Find in this conversation");
    type("needle");
    await screen.findByText("1 of 4");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByLabelText("Find in this conversation")).toBeNull();
    expect(container.querySelectorAll("mark.find-hit")).toHaveLength(0);
  });

  it("loads older pages when asked, with the 'Searching older messages…' note, and finds the match there", async () => {
    const calls = stub();
    const { container } = await open();
    type("old needle");
    await screen.findByText("No matches");
    fireEvent.click(screen.getByRole("button", { name: "Search older messages" }));
    await screen.findByText("1 of 1");
    expect(calls.some((c) => c.includes(`before=${id(20)}`))).toBe(true);
    expect(container.querySelector("mark.current")?.textContent).toBe("old needle");
    expect(screen.queryByRole("button", { name: "Search older messages" })).toBeNull();
  });
});
