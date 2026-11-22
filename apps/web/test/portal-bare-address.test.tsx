// @vitest-environment jsdom
// BOS-1680: the bare public address (no "#secret") opens the portal when the server has one for it, and says
// "incomplete" only when the server has none. The test reads what the page shows, not the status or title alone.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/pages/Portal";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("portal at the bare address", () => {
  it("shows the roadmap when the server answers for the empty link, never the 'incomplete' message", async () => {
    window.location.hash = "";
    const fetchMock = vi.fn(async () => json({ title: "What's next", intro: null, hasLogo: false, back: null, features: [{ id: "f1", title: "Dark mode", description: null, stage: "considering", myVote: null }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PortalApp />);
    await screen.findByRole("heading", { name: "What's next" });
    expect(screen.getByText("Dark mode")).toBeTruthy();
    expect(document.body.textContent).not.toContain("This link is incomplete");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("says the link is incomplete when the bare address has no portal behind it", async () => {
    window.location.hash = "";
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "not_found", message: "This portal link doesn't work. Ask for a new one." }, 404)));
    render(<PortalApp />);
    expect((await screen.findByRole("alert")).textContent).toContain("This link is incomplete");
  });
});
