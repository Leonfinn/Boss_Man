// @vitest-environment jsdom
// BOS-637: a server freeze, a restarted page or a failed send must not lose what the owner typed.
// Each box keeps its text in this browser and starts from it; a send clears it only once the
// server has taken it. The outage shows as a banner over the page, never in place of it.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { ChatPage } from "../src/pages/Chat";
import { clearAllDrafts, readDraft, saveDraft } from "../src/drafts";
import { reportFailure, reportAnswered, resetServerWatch } from "../src/server-watch";
import { ServerBanner } from "../src/App";

Element.prototype.scrollIntoView = () => {};
beforeEach(() => clearAllDrafts());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearAllDrafts();
  resetServerWatch();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [{ id: "a1", name: "Radagast", role: "ceo" }] } as unknown as Company;

/** The chat screens, with POSTs answering as `post` says (a failure by default throws like a dead server). */
function show(post: (body: Record<string, unknown>) => Response | Promise<Response> = () => json({ ok: true })) {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        return post(body);
      }
      if (url.includes("/chat/threads")) return json([{ id: "a1", name: "Radagast", role: "ceo", duty: null, state: "idle", last: null }]);
      if (url.includes("/chat?")) return json({ agentId: "a1", state: "idle", items: [] });
      return json([]);
    }),
  );
  render(<ChatPage companies={[company]} companyId="c1" agentId="a1" go={() => {}} onChanged={() => {}} />);
  return posts;
}

describe("drafts survive a freeze (BOS-637)", () => {
  it("keeps the chat box's text as it is typed, and writes it to this browser", async () => {
    show();
    const box = (await screen.findByLabelText(/Message to Radagast/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Half a thought about the deploy" } });
    expect(readDraft("chat/c1/a1")).toBe("Half a thought about the deploy");
  });

  it("a send that fails keeps the text and says it wasn't sent; the retry that works clears it", async () => {
    let down = true;
    const posts = show(() => {
      if (down) throw new TypeError("Failed to fetch");
      return json({ ok: true });
    });
    const box = (await screen.findByLabelText(/Message to Radagast/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Please look at BOS-637" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    expect(box.value).toBe("Please look at BOS-637");
    expect(readDraft("chat/c1/a1")).toBe("Please look at BOS-637");
    // The server is back: pressing Send again sends it once and clears the draft.
    down = false;
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(box.value).toBe(""));
    expect(posts.filter((p) => p.text === "Please look at BOS-637")).toHaveLength(2);
    expect(readDraft("chat/c1/a1")).toBe("");
  });

  it("never sends a kept draft on its own: it waits for the owner to press Send", async () => {
    saveDraft("chat/c1/a1", "left over from before the freeze");
    const posts = show();
    await screen.findByLabelText(/Message to Radagast/);
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(0);
  });
});

describe("the restarting banner (BOS-637)", () => {
  it("goes up when the server is away and comes down once a check answers", async () => {
    // The quiet health checks hang while the outage is on, so only the explicit answer takes it down.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<ServerBanner />);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => reportFailure({ status: 503 }));
    expect(screen.getByRole("status").textContent).toMatch(/restarting or switching versions/);
    await act(async () => reportAnswered());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves a refused click (a real error from the server) out of the banner", async () => {
    render(<ServerBanner />);
    await act(async () => reportFailure({ status: 404 }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
