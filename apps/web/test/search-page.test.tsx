// @vitest-environment jsdom
// BOS-2378: the Search page (#/search) shows every match, by kind with counts, one kind 25 at a time with "Show more",
// and a date filter; the Ctrl+K box links to it with "See all N results".
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPalette, type SearchHit, type SearchResults } from "../src/components/SearchPalette";
import { readSearchParams, SearchPage } from "../src/pages/Search";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const ticket = (i: number): SearchHit => ({ id: `t${i}`, title: `Osprey task ${i}`, ref: `BOS-${i}`, snippet: "", link: `tickets/t${i}` });
const counts = { tickets: 40, wiki: 1, chats: 0, features: 0, decisions: 2, runs: 0, agents: 0, skills: 0 };
const base: SearchResults = { q: "osprey", tickets: [], wiki: [], chats: [], features: [], decisions: [], runs: [], agents: [], skills: [], counts };
/** Where the page sends the browser: the address is the page's state, so the tests follow it like the router does. */
const open = async (hash: string) => {
  window.location.hash = hash;
  await act(async () => void window.dispatchEvent(new HashChangeEvent("hashchange")));
};
const asked = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => new URL(String(c[0]), "http://x").searchParams);

describe("Search page (BOS-2378)", () => {
  it("with no kind: each kind's first hits under its count, a link to all of a kind, and hits that link where the box goes", async () => {
    const f = vi.fn(async () =>
      json({
        ...base,
        tickets: Array.from({ length: 8 }, (_, i) => ticket(i)),
        wiki: [{ id: "birds", title: "Birds", snippet: "…the osprey…", link: "wiki/c1/birds" }],
        decisions: [{ id: "d1", title: "Approve the osprey deploy?", snippet: "Answered", at: "2026-11-20T08:00:00.000Z", link: "decisions/d1" }],
      }),
    );
    vi.stubGlobal("fetch", f);
    window.location.hash = "#/search?q=osprey";
    render(<SearchPage companyId="c1" go={() => {}} />);
    await screen.findByText("Birds");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Tickets (40)", "Wiki (1)", "Decisions (2)"]);
    expect(screen.getByRole("link", { name: "See all 40 tickets" }).getAttribute("href")).toBe("#/search?q=osprey&kind=tickets");
    // One of two decisions is shown, so it links to both; the one wiki page is all there is, so no link.
    expect(screen.getByRole("link", { name: "See all 2 decisions" }).getAttribute("href")).toBe("#/search?q=osprey&kind=decisions");
    expect(screen.queryByRole("link", { name: /See all 1 wiki/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Osprey task 0/ }).getAttribute("href")).toBe("#/tickets/t0");
    expect(screen.getByRole("link", { name: /Birds/ }).getAttribute("href")).toBe("#/wiki/c1/birds");
    // The kind select carries each kind's count.
    expect(screen.getByRole("option", { name: "Tickets (40)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "All kinds (43)" })).toBeTruthy();
    expect(asked(f)[0]!.get("kind")).toBeNull();
  });

  it("with a kind: 25 hits, then Show more asks for the next 25 from where it stopped and adds them", async () => {
    const f = vi.fn(async (url: string) => {
      const p = new URL(url, "http://x").searchParams;
      const offset = Number(p.get("offset"));
      const hits = Array.from({ length: Math.min(Number(p.get("limit")), 40 - offset) }, (_, i) => ticket(offset + i));
      return json({ ...base, tickets: hits });
    });
    vi.stubGlobal("fetch", f);
    window.location.hash = "#/search?q=osprey&kind=tickets";
    render(<SearchPage companyId="c1" go={() => {}} />);
    await screen.findByText("Osprey task 24");
    expect(screen.queryByText("Osprey task 25")).toBeNull();
    expect(Object.fromEntries(asked(f)[0]!)).toMatchObject({ q: "osprey", kind: "tickets", offset: "0", limit: "25" });
    const more = screen.getByRole("link", { name: "Show more" });
    expect(more.getAttribute("href")).toBe("#/search?q=osprey&kind=tickets&n=50");

    await open(more.getAttribute("href")!);
    await screen.findByText("Osprey task 39");
    expect(Object.fromEntries(asked(f)[1]!)).toMatchObject({ kind: "tickets", offset: "25", limit: "25" });
    // 25 then 15: all 40, each once.
    expect(screen.getAllByRole("listitem")).toHaveLength(40);
    expect(screen.queryByRole("link", { name: "Show more" })).toBeNull();

    // Back to 25: the list shrinks without asking again.
    await open("#/search?q=osprey&kind=tickets");
    expect(screen.getAllByRole("listitem")).toHaveLength(25);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("picks a kind and a date range through the address, and asks the server from that date", async () => {
    const f = vi.fn(async () => json({ ...base, tickets: [ticket(1)] }));
    vi.stubGlobal("fetch", f);
    const go = vi.fn();
    window.location.hash = "#/search?q=osprey&kind=tickets&n=50";
    render(<SearchPage companyId="c1" go={go} />);
    await screen.findByText("Osprey task 1");
    fireEvent.change(screen.getByRole("combobox", { name: "When" }), { target: { value: "7d" } });
    // A new filter starts the list again (no n).
    expect(go).toHaveBeenLastCalledWith("search?q=osprey&kind=tickets&since=7d");
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "" } });
    expect(go).toHaveBeenLastCalledWith("search?q=osprey");

    const before = Date.now();
    await open("#/search?q=osprey&since=7d");
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    const since = Date.parse(asked(f)[1]!.get("since")!);
    expect(Math.abs(since - (before - 7 * 86_400_000))).toBeLessThan(60_000);
  });

  it("searches new words on Enter, and offers Retry when the search fails", async () => {
    let fail = true;
    const f = vi.fn(async () => (fail ? new Response(JSON.stringify({ error: "boom", message: "Server said no" }), { status: 500, headers: { "content-type": "application/json" } }) : json({ ...base, tickets: [ticket(3)] })));
    vi.stubGlobal("fetch", f);
    const go = vi.fn();
    window.location.hash = "#/search?q=osprey";
    render(<SearchPage companyId="c1" go={go} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    fireEvent.click(retry);
    await screen.findByText("Osprey task 3");
    const box = screen.getByRole("searchbox", { name: "Words to search for" });
    fireEvent.change(box, { target: { value: " kestrel " } });
    fireEvent.submit(box.closest("form")!);
    expect(go).toHaveBeenLastCalledWith("search?q=kestrel");
  });

  it("reads only the kinds and dates it knows from the address", () => {
    expect(readSearchParams(new URLSearchParams("q=a&kind=emails&since=yesterday&n=abc"))).toEqual({ q: "a", kind: "", since: "", n: 25 });
    expect(readSearchParams(new URLSearchParams("q=a&kind=runs&since=30d&n=75"))).toEqual({ q: "a", kind: "runs", since: "30d", n: 75 });
  });
});

describe("the Ctrl+K box's See all link (BOS-2378)", () => {
  const ctrlK = () => fireEvent.keyDown(window, { key: "k", ctrlKey: true });

  it("counts every match and opens the Search page with the words filled in, closing the box", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...base, tickets: [ticket(1)] })));
    render(<SearchPalette companyId="c1" go={() => {}} />);
    ctrlK();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "osprey hunt" } });
    const link = await screen.findByRole("link", { name: "See all 43 results" });
    expect(link.getAttribute("href")).toBe("#/search?q=osprey+hunt");
    fireEvent.click(link);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays away when the server is older and sends no counts", async () => {
    const { counts: _gone, ...old } = { ...base, tickets: [ticket(1)] };
    vi.stubGlobal("fetch", vi.fn(async () => json(old)));
    render(<SearchPalette companyId="c1" go={() => {}} />);
    ctrlK();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "osprey" } });
    await screen.findByText("Osprey task 1");
    expect(screen.queryByRole("link", { name: /See all/ })).toBeNull();
  });
});
