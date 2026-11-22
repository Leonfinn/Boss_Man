// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ChatPage } from "../src/pages/Chat";

// BOS-2184: "Remember this" on the owner's own messages adds the text to the standing rules, with Undo.
Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "Radagast", role: "ceo" }] } as unknown as Company;

function show(appendReply: () => Response = () => json({ text: "x", max: 2000 })) {
  const posts: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return String(url).endsWith("/append") ? appendReply() : json({ text: "", max: 2000 });
      }
      if (url.includes("/chat/threads")) return json([{ id: "a1", name: "Radagast", role: "ceo", duty: null, state: "idle", last: null }]);
      if (url.includes("/chat?"))
        return json({
          agentId: "a1",
          state: "idle",
          items: [
            { id: "m1", role: "owner", text: "Never force-push", createdAt: "2026-11-21T10:00:00Z" },
            { id: "m2", role: "assistant", text: "Understood", createdAt: "2026-11-21T10:01:00Z" },
          ],
        });
      return json([]);
    }),
  );
  render(<ChatPage companies={[company]} companyId="c1" agentId="a1" go={() => {}} onChanged={() => {}} />);
  return posts;
}

describe("Chat: Remember this (BOS-2184)", () => {
  it("is offered on the owner's message only, adds the edited text, then Undo calls undo", async () => {
    const posts = show();
    const btn = await screen.findByRole("button", { name: "Remember this" });
    expect(screen.getAllByRole("button", { name: "Remember this" })).toHaveLength(1);
    fireEvent.click(btn);
    const box = screen.getByRole("textbox", { name: /standing rules/i }) as HTMLTextAreaElement;
    expect(box.value).toBe("Never force-push");
    fireEvent.change(box, { target: { value: "Never force-push to main" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to standing rules" }));
    await screen.findByText(/Added to standing rules/);
    expect(posts[0]).toEqual({ url: "/api/companies/c1/standing-rules/append", body: { text: "Never force-push to main" } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remember this" })).toBeTruthy());
    expect(posts[1]!.url).toBe("/api/companies/c1/standing-rules/undo");
  });

  it("Cancel adds nothing, and a refusal (too long) is shown and keeps the box open", async () => {
    const posts = show(() => json({ error: "invalid_standing_rules", message: "That doesn't fit: the standing rules are capped at 2000 characters." }, 400));
    fireEvent.click(await screen.findByRole("button", { name: "Remember this" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Remember this" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to standing rules" }));
    await screen.findByText(/capped at 2000 characters/);
    expect(screen.getByRole("button", { name: "Add to standing rules" })).toBeTruthy();
  });
});
