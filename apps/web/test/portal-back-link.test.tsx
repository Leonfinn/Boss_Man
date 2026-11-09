// @vitest-environment jsdom
// BOS-967: the portal's optional "← Back to …" links, and the owner's setting that turns them on.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Feedback } from "../src/pages/Feedback";
import { PortalApp } from "../src/pages/Portal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c-back", name: "App Co", mission: null, paused: false, agents: [] };
const settings = (extra: Record<string, unknown> = {}) => ({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: "t", portalTitle: "What's next", portalIntro: null, portalBackUrl: null, portalBackText: null, hasLogo: false, drivers: [], areas: [], ...extra });

describe("portal back link", () => {
  it("shows a bar at the top and a link at the bottom when the owner set an address", async () => {
    window.location.hash = "#tok";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/portal" ? json({ title: "What's next", intro: null, hasLogo: false, back: { url: "https://bossman.example/", text: "Boss Man" }, features: [] }) : json({}))));
    render(<PortalApp />);
    await screen.findByRole("heading", { name: "What's next" });
    const links = screen.getAllByRole("link", { name: /Back to Boss Man/ });
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute("href")).toBe("https://bossman.example/");
      expect(a.getAttribute("target")).toBeNull();
    }
    // One is in the top bar, ahead of the page, and one is after the last line.
    const bar = document.querySelector(".portal-back-bar");
    expect(bar?.contains(links[0]!)).toBe(true);
    expect(document.querySelector(".portal-back-foot")?.contains(links[1]!)).toBe(true);
    const main = document.querySelector("main.portal")!;
    expect(main.textContent).toContain("Votes are remembered in this browser");
    // The bottom link comes after the "Votes are remembered" line.
    const last = [...main.querySelectorAll("p")].at(-1)!;
    expect(last.closest(".portal-back-foot")).toBeTruthy();
  });

  it("shows no bar or bottom link when the address is not set", async () => {
    window.location.hash = "#tok";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/portal" ? json({ title: "What's next", intro: null, hasLogo: false, back: null, features: [] }) : json({}))));
    render(<PortalApp />);
    await screen.findByRole("heading", { name: "What's next" });
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector(".portal-back-bar")).toBeNull();
    expect(document.querySelector(".portal-back-foot")).toBeNull();
    // The page itself still starts with the heading, as it did before the setting existed.
    expect(document.querySelector("main.portal > header")).toBeTruthy();
  });

  it("the owner gets the error for an address without https://, and Save stays off", async () => {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => (url.includes("/feedback-settings") ? json(settings()) : url.endsWith("/features") ? json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] }) : json([])));
    vi.stubGlobal("fetch", fetchMock);
    render(<Feedback companies={[company]} companyId="c-back" noteId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Feedback portal/ }));
    const url = await screen.findByLabelText("Link back to your website (optional)");
    fireEvent.change(url, { target: { value: "example.com" } });
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a full web address that starts with https://");
    const save = screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest("form")!);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PATCH" && String(c[1].body).includes("backUrl"))).toBe(false);
  });

  it("the owner saves an https address and a short link text together", async () => {
    let saved: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes("/feedback-settings")) return json(settings(saved));
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
      if (init?.method === "PATCH" && url.endsWith("/portal")) {
        saved = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        return json(settings({ portalBackUrl: saved.backUrl, portalBackText: saved.backText }));
      }
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Feedback companies={[company]} companyId="c-back" noteId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Feedback portal/ }));
    fireEvent.change(await screen.findByLabelText("Link back to your website (optional)"), { target: { value: "https://bossman.example/" } });
    fireEvent.change(screen.getByLabelText("Link text (optional)"), { target: { value: "Boss Man" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);
    await waitFor(() => expect(saved).toEqual({ backUrl: "https://bossman.example/", backText: "Boss Man" }));
    expect(await screen.findByText("Back link saved.")).toBeTruthy();
  });
});
