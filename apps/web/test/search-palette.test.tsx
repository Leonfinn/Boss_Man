// @vitest-environment jsdom
// The search box (BOS-2192): Ctrl+K / Cmd+K and the sidebar button open it on any screen, Escape
// closes it, typing is debounced with nothing sent under 2 characters, and arrows + Enter open a result.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { Company } from "../src/api";
import { SEARCH_DEBOUNCE_MS, SearchPalette, type SearchResults } from "../src/components/SearchPalette";
import { ChatPage } from "../src/pages/Chat";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "Radagast", role: "ceo" }] } as unknown as Company;
const RESULTS: SearchResults = {
  q: "pelican",
  tickets: [{ id: "t1", title: "Teach the pelican", ref: "BOS-7", snippet: "", link: "tickets/t1" }],
  wiki: [{ id: "birds", title: "Birds", snippet: "…the pelican eats…", link: "wiki/c1/birds" }],
  chats: [{ id: "m1", title: "You, chat with Radagast", snippet: "Did the pelican land?", link: "chat/c1/a1/m1" }],
};

/** A fake server: search answers RESULTS and is recorded; everything else gets an empty answer. */
function server() {
  const searches: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/search?")) return (searches.push(new URL(url, "http://x").searchParams.get("q")!), json(RESULTS));
      if (url === "/api/setup") return json({ needsSetup: false });
      if (url === "/api/me") return json({ username: "leon" });
      if (url === "/api/companies") return json([company]);
      if (url === "/api/maintenance") return json({ on: false });
      if (url === "/api/notifications") return json({ items: [], unread: 0 });
      if (url.startsWith("/api/decisions/tally")) return json({ open: 0 });
      if (url === "/api/kill-switch") return json({ paused: false });
      return json([]);
    }),
  );
  return searches;
}

const ctrlK = (meta = false) => fireEvent.keyDown(window, { key: "k", ctrlKey: !meta, metaKey: meta });

describe("search box (BOS-2192)", () => {
  it("opens with Ctrl+K and Cmd+K on two different screens, closes with Escape, and opens from the sidebar button", async () => {
    server();
    window.location.hash = "#/dashboard";
    render(<App />);
    await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
    // The shell's DOM can be there a moment before React has run its effects (the key listener is one),
    // since the signed-in render came from a fetch outside act: press until the listener answers.
    await waitFor(() => {
      if (!screen.queryByRole("dialog", { name: "Search" })) ctrlK();
      expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
    });
    const box = screen.getByRole("combobox", { name: "Search tickets, wiki and chats" });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();

    // Another screen: the wiki.
    act(() => {
      window.location.hash = "#/wiki/c1";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    ctrlK(true);
    await screen.findByRole("dialog", { name: "Search" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();

    // No keyboard: the sidebar's button.
    fireEvent.click(screen.getByRole("button", { name: "Search tickets, wiki and chats" }));
    await screen.findByRole("dialog", { name: "Search" });
  });

  it("sends nothing under 2 characters and waits for typing to pause before asking", async () => {
    const searches = server();
    vi.useFakeTimers();
    render(<SearchPalette companyId="c1" go={() => {}} />);
    act(() => void window.dispatchEvent(new Event("bm-open-search")));
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "p" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 3));
    expect(searches).toEqual([]);
    fireEvent.change(box, { target: { value: "pe" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50));
    fireEvent.change(box, { target: { value: "pel" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 50));
    fireEvent.change(box, { target: { value: "pelican" } });
    await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1));
    expect(searches).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(searches).toEqual(["pelican"]);
  });

  it("arrow keys and Enter open the highlighted ticket, page or chat message", async () => {
    server();
    for (const [downs, link] of [[0, "tickets/t1"], [1, "wiki/c1/birds"], [2, "chat/c1/a1/m1"], [3, "tickets/t1"]] as const) {
      const go = vi.fn();
      render(<SearchPalette companyId="c1" go={go} />);
      ctrlK();
      const box = screen.getByRole("combobox");
      fireEvent.change(box, { target: { value: "pelican" } });
      await screen.findByText("Birds");
      for (let i = 0; i < downs; i++) fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "Enter" });
      expect(go).toHaveBeenCalledWith(link);
      expect(screen.queryByRole("dialog")).toBeNull();
      cleanup();
    }
    // Up from the first wraps to the last.
    const go = vi.fn();
    render(<SearchPalette companyId="c1" go={go} />);
    ctrlK();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pelican" } });
    await screen.findByText("Birds");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(go).toHaveBeenCalledWith("chat/c1/a1/m1");
  });
});

describe("chat opened from a search result (BOS-2192)", () => {
  const chat = (ids: string[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/chat/threads")) return json([{ id: "a1", name: "Radagast", role: "ceo", duty: null, state: "idle", last: null }]);
        if (url.includes("/chat?")) return json({ agentId: "a1", state: "idle", items: ids.map((id, i) => ({ id, role: "owner", text: `Message ${id}`, createdAt: new Date(2026, 10, 1, 10, i).toISOString() })) });
        return json([]);
      }),
    );

  it("scrolls to the message", async () => {
    chat(["m0", "m1", "m2"]);
    const seen: string[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      seen.push(this.id || this.className);
    });
    render(<ChatPage companies={[company]} companyId="c1" agentId="a1" messageId="m1" go={() => {}} onChanged={() => {}} />);
    await screen.findByText("Message m1");
    await waitFor(() => expect(seen).toContain("chat-msg-m1"));
    expect(seen[0]).toBe("chat-msg-m1");
    expect(document.getElementById("chat-msg-m1")!.className).toContain("found");
  });

  it("opens the chat with a note when the message is older than what is loaded", async () => {
    chat(["m5", "m6"]);
    render(<ChatPage companies={[company]} companyId="c1" agentId="a1" messageId="m1" go={() => {}} onChanged={() => {}} />);
    await screen.findByText("Message m6");
    await screen.findByText(/older than the messages shown here/);
  });
});
