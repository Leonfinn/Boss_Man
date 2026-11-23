// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ChatPage } from "../src/pages/Chat";

// BOS-2411: find in this conversation, and go to date.
Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "Radagast", role: "ceo" }] } as unknown as Company;
// Message i is on its own day: 1 Nov + i days, so a date picks one message.
const msg = (i: number, text = `msg-${i}`) => ({ id: `m${i}`, role: "owner", text, createdAt: new Date(2026, 9, 1 + i, 9).toISOString() });

// 60 newest messages (30..89); the older page holds 0..29 (hasMore false). "needle" is in 12 and 40 and 41.
const text = (i: number) => (i === 12 ? "an old needle here" : i === 40 ? "Needle one" : i === 41 ? "and NEEDLE two" : `msg-${i}`);
const mk = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(from + k, text(from + k)));

function stub(opts: { older?: unknown[]; hasMore?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/chat/threads")) return json([{ id: "a1", name: "Radagast", role: "ceo", duty: null, state: "idle", last: null }]);
      if (url.includes("before=m30")) return json({ agentId: "a1", state: "idle", hasMore: false, items: opts.older ?? mk(0, 30) });
      if (url.includes("/chat?")) return json({ agentId: "a1", state: "idle", hasMore: opts.hasMore ?? true, items: mk(30, 90) });
      return json([]);
    }),
  );
  return calls;
}
const renderChat = () => render(<ChatPage companies={[company]} companyId="c1" agentId="a1" go={() => {}} onChanged={() => {}} />);
const type = (v: string) => fireEvent.change(screen.getByLabelText("Find in this conversation"), { target: { value: v } });

describe("chat: find in this conversation (BOS-2411)", () => {
  it("highlights every match, says N of M, starts on the newest, and steps with the buttons and Enter", async () => {
    stub();
    const { container } = renderChat();
    await screen.findByText("msg-89");
    type("needle");
    await screen.findByText("2 of 2");
    expect(container.querySelectorAll("mark.find-hit")).toHaveLength(2);
    expect(container.querySelector("mark.current")?.textContent).toBe("NEEDLE");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("1 of 2");
    expect(container.querySelector("mark.current")?.textContent).toBe("Needle");
    fireEvent.keyDown(screen.getByLabelText("Find in this conversation"), { key: "Enter" });
    await screen.findByText("2 of 2");
    fireEvent.keyDown(screen.getByLabelText("Find in this conversation"), { key: "Enter", shiftKey: true });
    await screen.findByText("1 of 2");
  });

  it("clearing the box removes the highlights", async () => {
    stub();
    const { container } = renderChat();
    await screen.findByText("msg-89");
    type("needle");
    await screen.findByText("2 of 2");
    type("");
    await waitFor(() => expect(container.querySelectorAll("mark")).toHaveLength(0));
    expect(screen.queryByText("2 of 2")).toBeNull();
  });

  it("Search older messages loads the older page and says how many were found", async () => {
    const calls = stub();
    const { container } = renderChat();
    await screen.findByText("msg-89");
    type("old needle");
    await screen.findByText("No matches");
    fireEvent.click(screen.getByRole("button", { name: "Search older messages" }));
    await screen.findByText("1 more found");
    expect(calls.some((u) => u.includes("before=m30"))).toBe(true);
    expect(container.querySelector("mark.current")?.textContent).toBe("old needle");
    expect(screen.queryByRole("button", { name: "Search older messages" })).toBeNull();
  });

  it("says so when older messages hold no match and the start is reached", async () => {
    stub();
    renderChat();
    await screen.findByText("msg-89");
    type("zebra");
    await screen.findByText("No matches");
    fireEvent.click(screen.getByRole("button", { name: "Search older messages" }));
    await screen.findByText("No more matches; start of the conversation");
  });

  it("Go to date loads back to the day; a date before the chat's start says so", async () => {
    const calls = stub();
    renderChat();
    await screen.findByText("msg-89");
    const date = screen.getByLabelText("Go to date");
    fireEvent.change(date, { target: { value: "2026-10-06" } });
    await waitFor(() => expect(calls.some((u) => u.includes("before=m30"))).toBe(true));
    await screen.findByText("msg-5");
    expect(screen.queryByText(/doesn't go back that far/)).toBeNull();
    fireEvent.change(date, { target: { value: "2020-01-01" } });
    await screen.findByText(/doesn't go back that far: it starts on 1 October 2026|doesn't go back that far: it starts on October 1, 2026/);
  });
});
