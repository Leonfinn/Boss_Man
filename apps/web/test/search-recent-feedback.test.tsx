// @vitest-environment jsdom
// BOS-2433: feedback notes show as their own group in the search box, and an empty box lists the last 5 searches.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRecent, readRecent, rememberSearch, RECENT_KEY, SearchPalette, type SearchResults } from "../src/components/SearchPalette";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const ctrlK = () => fireEvent.keyDown(window, { key: "k", ctrlKey: true });

describe("recent searches (BOS-2433)", () => {
  it("keeps the newest 5, no repeats (any case), and ignores broken storage", () => {
    for (const w of ["one1", "two2", "three", "four", "five5", "six66", "ONE1"]) rememberSearch(w);
    expect(readRecent()).toEqual(["ONE1", "six66", "five5", "four", "three"]);
    rememberSearch("x");
    expect(readRecent()).toHaveLength(5);
    window.localStorage.setItem(RECENT_KEY, "{not json");
    expect(readRecent()).toEqual([]);
    clearRecent();
    expect(window.localStorage.getItem(RECENT_KEY)).toBeNull();
  });

  it("lists them in an empty box, runs one on Enter or a click, and Clear empties the list", async () => {
    rememberSearch("osprey");
    rememberSearch("dark mode");
    const fetchMock = vi.fn(async () => json({ q: "dark mode", tickets: [], wiki: [], chats: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SearchPalette companyId="c1" go={() => {}} />);
    ctrlK();
    const items = screen.getAllByRole("option");
    expect(items.map((i) => i.textContent)).toEqual(["dark mode", "osprey"]);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("osprey");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]![0])).toContain("q=osprey");
    cleanup();

    render(<SearchPalette companyId="c1" go={() => {}} />);
    ctrlK();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("Recent searches")).toBeNull();
    expect(readRecent()).toEqual([]);
  });

  it("remembers the words when a hit is picked", async () => {
    const results: SearchResults = { q: "dark", tickets: [], wiki: [], chats: [], feedback: [{ id: "n1", title: "Dark mode please", snippet: "", at: "2026-11-20T08:00:00.000Z", link: "feedback/c1/n1" }] };
    vi.stubGlobal("fetch", vi.fn(async () => json(results)));
    const go = vi.fn();
    render(<SearchPalette companyId="c1" go={go} />);
    ctrlK();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "dark" } });
    expect(await screen.findByRole("heading", { level: 3, name: "Feedback" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(go).toHaveBeenCalledWith("feedback/c1/n1");
    expect(readRecent()).toEqual(["dark"]);
  });
});
