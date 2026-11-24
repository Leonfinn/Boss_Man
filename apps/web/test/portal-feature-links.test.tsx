// @vitest-environment jsdom
// BOS-2391: each feature has its own link (kept alongside the link secret), opening it switches to the column and
// highlights the card; a search box narrows the columns; the feed is advertised only at the bare address.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { featureLink, matchesSearch, PortalApp } from "../src/pages/Portal";

const copyText = vi.fn(async (_t: string) => true);
vi.mock("../src/clipboard", () => ({ copyText: (text: string) => copyText(text) }));
const json =(body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const f = (id: string, title: string, stage: string, description: string | null = null) => ({ id, title, description, stage, releasedAt: stage === "released" ? "2026-11-20T10:00:00Z" : null, myVote: null });
const FEATURES = [f("a1", "Dark mode", "considering", "Easier on the eyes"), f("b2", "Faster boards", "planned"), f("c3", "Email digests", "released", "A weekly summary")];
const stub = () => vi.stubGlobal("fetch", vi.fn(async () => json({ title: "Roadmap", intro: null, hasLogo: false, back: null, features: FEATURES })));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  document.head.querySelectorAll('link[rel="alternate"]').forEach((l) => l.remove());
});

describe("portal feature links", () => {
  it("builds the link with the secret kept, and without one at the bare address", () => {
    const loc = { origin: "https://example.com", pathname: "/portal.html", hash: "" };
    window.location.hash = "";
    expect(featureLink("x1", loc)).toBe("https://example.com/portal.html#feature-x1");
    window.location.hash = "#" + "s".repeat(32);
    expect(featureLink("x1", loc)).toBe(`https://example.com/portal.html#${"s".repeat(32)}&feature-x1`);
  });

  it("opens a feature link on its column and lights the card, with the secret still working", async () => {
    window.location.hash = `#${"s".repeat(32)}&feature-c3`;
    stub();
    render(<PortalApp />);
    const card = await waitFor(() => {
      const el = document.getElementById("feature-c3");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(screen.getByRole("tab", { name: /What's new/ }).getAttribute("aria-selected")).toBe("true");
    expect(card.getAttribute("data-lit")).toBe("true");
    const fetchMock = vi.mocked(fetch);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "x-portal-token": "s".repeat(32) });
  });

  it("copies a card's link", async () => {
    window.location.hash = "";
    stub();
    const writeText = copyText;
    render(<PortalApp />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Copy link" }))[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/#feature-a1$/)));
  });

  it("narrows by title or summary words, and says so when nothing matches", async () => {
    stub();
    render(<PortalApp />);
    const box = await screen.findByLabelText("Search features");
    fireEvent.change(box, { target: { value: "eyes dark" } });
    expect(screen.getByText("Dark mode")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Planned/ }).textContent).toContain("0");
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("No features match")).toBeTruthy();
    expect(matchesSearch({ title: "A", description: null }, "  ")).toBe(true);
  });

  it("advertises the feed in the head at the bare address only", async () => {
    window.location.hash = "";
    stub();
    render(<PortalApp />);
    await screen.findByLabelText("Search features");
    // The link is added by an effect after the first paint: wait for it rather than assume it ran with the box.
    await waitFor(() => expect(document.head.querySelector('link[rel="alternate"][type="application/atom+xml"]')).toBeTruthy());
    cleanup();
    document.head.querySelectorAll('link[rel="alternate"]').forEach((l) => l.remove());
    window.location.hash = "#" + "s".repeat(32);
    render(<PortalApp />);
    await screen.findByLabelText("Search features");
    expect(document.head.querySelector('link[rel="alternate"]')).toBeNull();
  });
});
