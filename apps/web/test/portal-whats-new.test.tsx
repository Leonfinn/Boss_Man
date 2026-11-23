// @vitest-environment jsdom
// BOS-2377: the Released tab is "What's new": released features under month headings, newest first, each with its
// date, and a plain link to the Atom feed (only at the bare address, where a feed reader can reach the portal).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupByMonth, PortalApp } from "../src/pages/Portal";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const feature = (id: string, title: string, releasedAt: string | null, stage = "released") => ({ id, title, description: null, stage, releasedAt, myVote: null });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("portal What's new", () => {
  it("groups released features by month, newest first, with dates and the feed link", async () => {
    window.location.hash = "";
    vi.stubGlobal("fetch", vi.fn(async () => json({ title: "Roadmap", intro: null, hasLogo: false, back: null, features: [feature("a", "Older one", "2026-10-02T10:00:00Z"), feature("b", "Newest one", "2026-11-20T10:00:00Z"), feature("c", "Mid one", "2026-11-03T10:00:00Z")] })));
    render(<PortalApp />);
    fireEvent.click(await screen.findByRole("tab", { name: /What's new/ }));
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(["November 2026", "October 2026"]);
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Newest one", "Mid one", "Older one"]);
    expect(screen.getByText("November 20, 2026")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Follow new releases (Atom feed)" }).getAttribute("href")).toBe("/api/portal/feed.atom");
  });

  it("puts a release with no date last under 'Earlier'; no feed link on a secret-link portal", () => {
    expect(groupByMonth([{ releasedAt: null }, { releasedAt: "2026-11-01T00:00:00Z" }]).map((g) => g.month)).toEqual(["November 2026", "Earlier"]);
  });

  it("hides the feed link when the page was opened with a link secret", async () => {
    window.location.hash = "#" + "a".repeat(32);
    vi.stubGlobal("fetch", vi.fn(async () => json({ title: "Roadmap", intro: null, hasLogo: false, back: null, features: [feature("a", "Shipped", "2026-11-20T10:00:00Z")] })));
    render(<PortalApp />);
    fireEvent.click(await screen.findByRole("tab", { name: /What's new/ }));
    expect(screen.queryByRole("link", { name: /Atom feed/ })).toBeNull();
  });
});
