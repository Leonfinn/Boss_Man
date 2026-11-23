// @vitest-environment jsdom
// BOS-2320: the Runs page's "Waiting to start" list: queued and deferred wakes, empty text, load error with Retry.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Runs, waitingFor } from "../src/pages/Runs";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const companies = [{ id: "co-1", name: "App Co", agents: [] }] as unknown as Company[];
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

describe("waitingFor", () => {
  it("says how long in plain words", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    expect(waitingFor("2026-11-23T11:48:00Z", now)).toBe("waiting 12 min");
    expect(waitingFor("2026-11-23T09:55:00Z", now)).toBe("waiting 2 h 5 min");
    expect(waitingFor("2026-11-23T11:59:50Z", now)).toBe("waiting less than a minute");
  });
});

describe("Runs page: Waiting to start (BOS-2320)", () => {
  it("lists each waiting wake with its ticket, reason and, for a held one, why and until when", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/companies/co-1/wakes/waiting"
          ? json([
              { id: "w1", agentId: "a1", agent: "Ada", ticketId: "t-1", ticket: "Fix login", ticketRef: "BOS-12", reason: "assigned", status: "queued", statusReason: null, notBefore: null, createdAt: ago(12) },
              { id: "w2", agentId: "a1", agent: "Bo", ticketId: null, ticket: null, ticketRef: null, reason: "chat", status: "deferred", statusReason: "quiet hours", notBefore: ago(-30), createdAt: ago(5) },
            ])
          : json([]),
      ),
    );
    render(<Runs companies={companies} />);
    expect(await screen.findByText("Ada")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Fix login" }).getAttribute("href")).toBe("#/tickets/t-1");
    expect(screen.getByText("waiting 12 min")).toBeTruthy();
    expect(screen.getByText(/Held: quiet hours until/)).toBeTruthy();
    expect(screen.queryByText("No agents are waiting to start.")).toBeNull();
  });

  const wake = { id: "w1", agentId: "a1", agent: "Ada", ticketId: null, ticket: null, ticketRef: null, reason: "chat", status: "queued", statusReason: null, notBefore: null, createdAt: ago(3) };

  it("Cancel asks for a reason, posts it, and the row goes", async () => {
    let gone = false;
    const posts: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("prompt", vi.fn(() => "not needed"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push({ url, body: String(init.body) });
          gone = true;
          return json({ ok: true });
        }
        return url === "/api/companies/co-1/wakes/waiting" ? json(gone ? [] : [wake]) : json([]);
      }),
    );
    render(<Runs companies={companies} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("No agents are waiting to start.")).toBeTruthy());
    expect(posts).toEqual([{ url: "/api/companies/co-1/wakes/w1/cancel", body: JSON.stringify({ reason: "not needed" }) }]);
  });

  it("Cancel does nothing when the owner dismisses the confirm", async () => {
    vi.stubGlobal("prompt", vi.fn(() => null));
    const f = vi.fn(async (url: string) => (url === "/api/companies/co-1/wakes/waiting" ? json([wake]) : json([])));
    vi.stubGlobal("fetch", f);
    render(<Runs companies={companies} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("Start now on a wake that cannot start says it is waiting for a slot, not that it started", async () => {
    vi.stubGlobal("prompt", vi.fn(() => ""));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        init?.method === "POST" ? json({ ok: true, started: false, waitingReason: "all run slots are busy" }) : url === "/api/companies/co-1/wakes/waiting" ? json([wake]) : json([]),
      ),
    );
    render(<Runs companies={companies} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start now" }));
    expect(await screen.findByText(/Not started yet: all run slots are busy/)).toBeTruthy();
  });

  it("says so when nobody is waiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(<Runs companies={companies} />);
    expect(await screen.findByText("No agents are waiting to start.")).toBeTruthy();
  });

  it("shows a load error with Retry instead of an empty list", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.includes("/wakes/waiting") && fail ? new Response("{}", { status: 500 }) : json([]))),
    );
    render(<Runs companies={companies} />);
    expect(await screen.findByText(/Couldn't load the agents waiting to start/)).toBeTruthy();
    fail = false;
    const retry = screen.getAllByRole("button", { name: "Retry" })[0]!;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("No agents are waiting to start.")).toBeTruthy());
  });
});
