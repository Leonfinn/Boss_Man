// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ChatPage } from "../src/pages/Chat";

// BOS-2167: "Load older messages" for chats longer than the newest 200.
Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "Radagast", role: "ceo" }] } as unknown as Company;
const msg = (i: number) => ({ id: `m${i}`, role: "owner", text: `msg-${i}`, createdAt: new Date(2026, 10, 1, 0, 0, i).toISOString() });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(from + k));

function stub(newest: () => unknown[], hasMore: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/chat/threads")) return json([{ id: "a1", name: "Radagast", role: "ceo", duty: null, state: "idle", last: null }]);
      if (url.includes("before=m50")) return json({ agentId: "a1", state: "idle", hasMore: false, items: range(0, 50) });
      if (url.includes("/chat?")) return json({ agentId: "a1", state: "idle", hasMore, items: newest() });
      return json([]);
    }),
  );
}
const renderChat = () => render(<ChatPage companies={[company]} companyId="c1" agentId="a1" go={() => {}} onChanged={() => {}} />);

describe("chat: Load older messages (BOS-2167)", () => {
  it("shows the button for a long chat; pressing it adds the older page in order and the button goes", async () => {
    stub(() => range(50, 250), true);
    const { container } = renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Load older messages" }));
    await screen.findByText("msg-0");
    const texts = [...container.querySelectorAll(".chat-msg p")].map((p) => p.textContent);
    expect(texts).toHaveLength(250);
    expect(texts[0]).toBe("msg-0");
    expect(texts[249]).toBe("msg-249");
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
  });

  it("keeps the older messages on screen when a new message arrives", async () => {
    let tail: unknown[] = [];
    stub(() => [...range(50, 250), ...tail], true);
    const { container } = renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Load older messages" }));
    await screen.findByText("msg-0");
    tail = [msg(250)];
    // the 5 s poll is real time; a reload happens through the send path, so trigger a focus-free wait for it
    await screen.findByText("msg-250", {}, { timeout: 8000 });
    expect(screen.getByText("msg-0")).toBeTruthy();
    expect([...container.querySelectorAll(".chat-msg p")].at(-1)?.textContent).toBe("msg-250");
  }, 15000);

  it("shows no button for a chat under 200 messages", async () => {
    stub(() => range(0, 5), false);
    renderChat();
    await screen.findByText("msg-4");
    expect(screen.queryByRole("button", { name: "Load older messages" })).toBeNull();
  });
});
