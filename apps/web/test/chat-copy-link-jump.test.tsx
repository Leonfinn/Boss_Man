// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ChatPage } from "../src/pages/Chat";

// BOS-2440: "Copy link" on each message, and "Jump to newest" with a count when the reader has scrolled up.
const scrolled = vi.fn();
Element.prototype.scrollIntoView = function (this: Element) {
  scrolled(this);
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  scrolled.mockReset();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "Radagast", role: "ceo" }] } as unknown as Company;
const msg = (n: number) => ({ id: `m${n}`, role: n % 2 ? "owner" : "assistant", text: `Message ${n}`, createdAt: `2026-11-21T10:0${n}:00Z` });

function show(items: { current: ReturnType<typeof msg>[] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/chat/threads")) return json([{ id: "a1", name: "Radagast", role: "ceo", duty: null, state: "idle", last: null }]);
      if (url.includes("/chat?")) return json({ agentId: "a1", state: "idle", items: items.current });
      return json([]);
    }),
  );
  render(<ChatPage companies={[company]} companyId="c1" agentId="a1" go={() => {}} onChanged={() => {}} />);
}

function scrollUp(log: HTMLElement, top: number) {
  Object.defineProperty(log, "scrollHeight", { configurable: true, value: 4000 });
  Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
  Object.defineProperty(log, "scrollTop", { configurable: true, writable: true, value: top });
  fireEvent.scroll(log);
}

describe("Chat: Copy link (BOS-2440)", () => {
  it("copies the message's own route, and says Link copied", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    show({ current: [msg(1), msg(2)] });
    const buttons = await screen.findAllByRole("button", { name: "Copy link" });
    expect(buttons).toHaveLength(2);
    await act(async () => void fireEvent.click(buttons[1]!));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${window.location.pathname}#/chat/c1/a1/m2`);
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeTruthy();
  });

  it("shows the link in a selectable box when the clipboard is refused", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => Promise.reject(new Error("no")) } });
    document.execCommand = () => false;
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    show({ current: [msg(1)] });
    const copy = await screen.findByRole("button", { name: "Copy link" });
    await act(async () => void fireEvent.click(copy));
    const field = (await screen.findByRole("textbox", { name: /Copy the link by hand/ })) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe(`${window.location.origin}${window.location.pathname}#/chat/c1/a1/m1`);
  });
});

describe("Chat: Jump to newest (BOS-2440)", () => {
  it("appears past one screen up, counts new messages without moving the reader, and hides on click", async () => {
    const items = { current: [msg(1), msg(2)] };
    show(items);
    await screen.findByText("Message 2");
    const log = screen.getByRole("log");
    expect(screen.queryByRole("button", { name: /Jump to newest|new ↓/ })).toBeNull();
    scrollUp(log, 500);
    expect(await screen.findByRole("button", { name: "Jump to newest ↓" })).toBeTruthy();
    scrolled.mockReset();
    items.current = [msg(1), msg(2), msg(3), msg(4)];
    const btn = await screen.findByRole("button", { name: "2 new ↓" }, { timeout: 9000 });
    await screen.findByText("Message 4");
    expect(scrolled).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(scrolled).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("button", { name: /new ↓|Jump to newest/ })).toBeNull());
  }, 20000);

  it("stays hidden within one screen of the bottom", async () => {
    show({ current: [msg(1), msg(2)] });
    await screen.findByText("Message 2");
    scrollUp(screen.getByRole("log"), 3400);
    expect(screen.queryByRole("button", { name: /Jump to newest|new ↓/ })).toBeNull();
  });
});
