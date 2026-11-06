// @vitest-environment jsdom
// BOS-502: the run page's "Message the agent" box takes a long paste whole, like every other owner
// box: it shows a count, warns before sending past the limit and offers to send it as a .txt file.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_MESSAGE_MAX } from "@boss-man/shared";
import type { Company } from "../src/api";
import { Run } from "../src/pages/Run";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [] } as unknown as Company;

function stub(posts: Array<{ url: string; body: Record<string, unknown> }>, ticketId: string | null = "t1") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith("/images")) return json({ markdown: "[📎 message.txt](/api/ticket-images/00000000-0000-0000-0000-000000000001)" });
        return json({ delivered: "queued" });
      }
      if (url.includes("/transcript"))
        return json({ run: { id: "r1", companyId: "c1", agent: "Ada", agentId: "a1", ticketId, ticket: ticketId ? "BOS-1" : null, startedAt: "2026-11-05T10:00:00Z", endedAt: null }, items: [], next: 0, more: false });
      return json([]);
    }),
  );
}

describe("the run page's message box (BOS-502)", () => {
  it("is the shared box: no maxLength, and it takes a 200,000-character paste", async () => {
    stub([]);
    render(<Run runId="r1" companies={[company]} />);
    const box = (await screen.findByLabelText("Message the agent")) as HTMLTextAreaElement;
    expect(box.getAttribute("maxLength")).toBeNull();
    const big = "x".repeat(OWNER_MESSAGE_MAX);
    fireEvent.change(box, { target: { value: big } });
    expect(box.value).toHaveLength(OWNER_MESSAGE_MAX);
    expect(screen.getByText(new RegExp(`^${OWNER_MESSAGE_MAX.toLocaleString()} of ${OWNER_MESSAGE_MAX.toLocaleString()} characters`))).toBeTruthy();
    // A 200k message is sent whole, not stopped by the box.
    fireEvent.click(screen.getByRole("button", { name: "Send after this turn" }));
    const post = await waitFor(() => {
      const found = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.map(([u, i]) => ({ url: u, body: JSON.parse(String(i?.body ?? "{}")) }));
      const sent = found.find((p) => p.url.endsWith("/api/runs/r1/message"));
      expect(sent).toBeTruthy();
      return sent!;
    });
    expect(post.body.text).toHaveLength(OWNER_MESSAGE_MAX);
  });

  it("past the limit it warns before sending and offers a .txt file on the run's ticket", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    stub(posts);
    render(<Run runId="r1" companies={[company]} />);
    const box = await screen.findByLabelText("Message the agent");
    fireEvent.change(box, { target: { value: "x".repeat(OWNER_MESSAGE_MAX + 1) } });
    expect(screen.getByRole("note").textContent).toMatch(/longer than a message can/);
    expect((screen.getByRole("button", { name: "Send after this turn" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send as a .txt file" }));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/api/companies/c1/images"))).toBe(true));
    const message = await waitFor(() => {
      const sent = posts.find((p) => p.url.endsWith("/api/tickets/t1/messages"));
      expect(sent).toBeTruthy();
      return sent!;
    });
    expect(String(message.body.text)).toContain("/api/ticket-images/");
  });

  it("a run with no ticket has no .txt offer, since it can't attach to one", async () => {
    stub([], null);
    render(<Run runId="r1" companies={[company]} />);
    fireEvent.change(await screen.findByLabelText("Message the agent"), { target: { value: "x".repeat(OWNER_MESSAGE_MAX + 1) } });
    expect(screen.queryByRole("button", { name: "Send as a .txt file" })).toBeNull();
  });
});
