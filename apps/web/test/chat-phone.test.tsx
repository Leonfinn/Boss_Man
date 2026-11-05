// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ChatPage } from "../src/pages/Chat";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "Radagast", role: "ceo" }] } as unknown as Company;

/** The chat load, and a record of what was sent. */
function show() {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return (posts.push(JSON.parse(String(init.body))), json({ ok: true }));
      if (url.includes("/chat/threads")) return json([{ id: "a1", name: "Radagast", role: "ceo", duty: null, state: "idle", last: null }]);
      if (url.includes("/chat?")) return json({ agentId: "a1", state: "idle", items: [] });
      return json([]);
    }),
  );
  render(<ChatPage companies={[company]} companyId="c1" agentId="a1" go={() => {}} onChanged={() => {}} />);
  return posts;
}

// A phone reports a coarse pointer and a narrow screen; a touch laptop is coarse but wide, so it
// answers true for `(pointer: coarse)` and false for the width part of the combined query.
const pointer = (phone: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: phone && q.includes("max-width"), media: q, addEventListener: () => {}, removeEventListener: () => {} }));

describe("chat on a phone (BOS-245)", () => {
  it("Return adds a line and Send sends, and the placeholder has no keyboard hint", async () => {
    pointer(true);
    const posts = show();
    const box = (await screen.findByLabelText("Message to Radagast")) as HTMLTextAreaElement;
    expect(box.getAttribute("placeholder")).toBe("Message Radagast");
    expect(box.getAttribute("enterKeyHint")).toBe("newline");
    fireEvent.change(box, { target: { value: "first line" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts).toEqual([{ text: "first line", agentId: "a1" }]));
  });

  it("on a desktop, Return still sends", async () => {
    pointer(false);
    const posts = show();
    const box = (await screen.findByLabelText("Message to Radagast")) as HTMLTextAreaElement;
    expect(box.getAttribute("placeholder")).toBe("Message Radagast. Enter sends, Shift+Enter adds a line.");
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(posts).toEqual([{ text: "hello", agentId: "a1" }]));
  });

  it("a touch laptop (coarse but wide) keeps Return-to-send, so a physical keyboard still sends", async () => {
    pointer(false);
    const posts = show();
    const box = (await screen.findByLabelText("Message to Radagast")) as HTMLTextAreaElement;
    expect(box.getAttribute("placeholder")).toBe("Message Radagast. Enter sends, Shift+Enter adds a line.");
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(posts).toEqual([{ text: "hi", agentId: "a1" }]));
  });
});
