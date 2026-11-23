// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ChatPage } from "../src/pages/Chat";

// BOS-2313: "Download" the whole conversation as Markdown, paging back through every older page.
Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "Rada Gast", role: "ceo" }] } as unknown as Company;
const msg = (i: number, role = "owner") => ({ id: `m${i}`, role, text: `msg-${i}`, createdAt: new Date(Date.UTC(2026, 10, 1, 8, 0, i)).toISOString(), trace: role === "assistant" ? { secs: 1, steps: [{ title: "thinking-trace", items: [] }] } : undefined });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(from + k, (from + k) % 2 ? "assistant" : "owner"));

describe("chat download (BOS-2313)", () => {
  it("pages back to the start and saves oldest first, no traces", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/chat/threads")) return json([{ id: "a1", name: "Rada Gast", role: "ceo", duty: null, state: "idle", last: null }]);
        if (url.includes("before=m100")) return json({ agentId: "a1", state: "idle", hasMore: true, items: range(50, 100) });
        if (url.includes("before=m50")) return json({ agentId: "a1", state: "idle", hasMore: false, items: range(0, 50) });
        if (url.includes("/chat?")) return json({ agentId: "a1", state: "idle", hasMore: true, items: range(100, 300) });
        return json([]);
      }),
    );
    const blobs: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => (blobs.push(b), "blob:x");
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    render(<ChatPage companies={[company]} companyId="c1" agentId="a1" go={() => {}} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    await screen.findByRole("button", { name: "Preparing" });
    await vi.waitFor(() => expect(blobs).toHaveLength(1));
    expect(names[0]).toMatch(/^chat-rada-gast-\d{4}-\d{2}-\d{2}\.md$/);
    const text = await blobs[0]!.text();
    expect(text).toMatch(/^# Chat with Rada Gast, \d{4}-\d{2}-\d{2}\n/);
    expect(text).toContain("**You** · 2026-11-01 08:00 UTC\n\nmsg-0\n");
    expect(text).toContain("**Rada Gast** · 2026-11-01 08:00 UTC\n\nmsg-1\n");
    expect(text).not.toContain("thinking-trace");
    const order = [...text.matchAll(/msg-(\d+)/g)].map((m) => Number(m[1]));
    expect(order).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });
});
