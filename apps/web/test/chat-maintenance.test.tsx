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

// BOS-2404: chat stays open through every update hold; the banner says what the update waits on, and holds the chat only
// while a runner is being swapped, with the time it answers again at the latest.
describe("chat while a runner update waits (BOS-349, BOS-2404)", () => {
  it("says the update is waiting for N agents while chat stays open", () => {
    render(<UpdateNote m={{ on: true, runs: 2, chatOpen: true }} />);
    expect(screen.getByRole("status").textContent).toBe("Update waiting for 2 agents to finish. Chat stays open.");
  });

  it("gives the real expected time for checks, or says it is overdue (BOS-1877)", () => {
    const iso = new Date(2026, 10, 19, 14, 5).toISOString();
    const { unmount } = render(<UpdateNote m={{ on: true, runs: 0, chatOpen: true, phase: "waiting", checks: 1, expectedFinishAt: iso }} />);
    expect(screen.getByRole("status").textContent).toMatch(/^Update waiting for running checks to finish, expected about .*\. Chat stays open\.$/);
    unmount();
    render(<UpdateNote m={{ on: true, runs: 0, chatOpen: true, phase: "waiting", checks: 1, expectedFinishAt: null, overdue: true }} />);
    expect(screen.getByRole("status").textContent).toMatch(/taking longer than expected/);
  });

  it("says a merge being pushed, or a wait on nothing it can name, keeps chat open (BOS-1951)", () => {
    const { unmount } = render(<UpdateNote m={{ on: true, runs: 0, chatOpen: true, phase: "waiting", merges: 1 }} />);
    expect(screen.getByRole("status").textContent).toBe("Update waiting for a merge being pushed to main. Chat stays open.");
    unmount();
    render(<UpdateNote m={{ on: true, runs: 0, chatOpen: true, phase: "waiting", overdue: true, unknownWait: true }} />);
    expect(screen.getByRole("status").textContent).toMatch(/running late.*Chat stays open.*stop waiting or cancel/);
  });

  it("says it in the singular for one agent", () => {
    render(<UpdateNote m={{ on: true, runs: 1, chatOpen: true }} />);
    expect(screen.getByRole("status").textContent).toBe("Update waiting for 1 agent to finish. Chat stays open.");
  });

  it("a wrap-up keeps chat open (BOS-2404)", () => {
    render(<UpdateNote m={{ on: true, kind: "wrapup", runs: 0, chatOpen: true }} />);
    expect(screen.getByRole("status").textContent).toBe("Agents were asked to wrap up. Nothing new starts, but chat stays open.");
  });

  it("while a runner is being swapped, says so and when chat answers again (BOS-2404)", () => {
    const iso = new Date(2026, 10, 23, 20, 34).toISOString();
    render(<UpdateNote m={{ on: true, runs: 0, chatOpen: false, chatBackBy: iso, phase: "swapping" }} />);
    expect(screen.getByRole("status").textContent).toMatch(/^Swapping the runners to the new version now, usually under a minute \(chat answers again by .+ at the latest\)\. New messages are saved and answered then\.$/);
  });

  it("with no agent left, says the swap is next and chat is open; the composer still sends", async () => {
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
    render(<ChatPage companies={[company]} companyId="c1" agentId="a1" maintenance={{ on: true, runs: 0, chatOpen: true }} go={() => {}} onChanged={() => {}} />);
    // The loader is a status too while the first load runs, so find the banner by its words.
    expect(await screen.findByText("Update about to swap the runners. Chat stays open until the swap itself, which usually takes under a minute.")).toBeTruthy();
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
