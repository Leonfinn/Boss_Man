// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ChatPage, UpdateNote } from "../src/pages/Chat";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "Radagast", role: "ceo" }] } as unknown as Company;

describe("chat while a runner update waits (BOS-349)", () => {
  it("says the update is waiting for N agents while chat stays open", () => {
    render(<UpdateNote m={{ on: true, runs: 2, chatOpen: true }} />);
    expect(screen.getByRole("status").textContent).toBe("Update waiting for 2 agents to finish: chat stays open until then.");
  });

  it("says it in the singular for one agent", () => {
    render(<UpdateNote m={{ on: true, runs: 1, chatOpen: true }} />);
    expect(screen.getByRole("status").textContent).toBe("Update waiting for 1 agent to finish: chat stays open until then.");
  });

  it("warns the swap is imminent when no agent is left, without blocking the composer", async () => {
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
    render(<ChatPage companies={[company]} companyId="c1" agentId="a1" maintenance={{ on: true, runs: 0, chatOpen: false }} go={() => {}} onChanged={() => {}} />);
    expect((await screen.findByRole("status")).textContent).toBe("Updating, back in a moment. New messages are saved and answered when it is done.");
    // The message is still sent: it is stored and answered once the update is done.
    const box = (await screen.findByLabelText("Message to Radagast")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "wind up please" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts).toEqual([{ text: "wind up please", agentId: "a1" }]));
  });

  it("shows nothing when no update is pending", () => {
    const { container } = render(<UpdateNote m={{ on: false }} />);
    expect(container.firstChild).toBeNull();
  });
});
