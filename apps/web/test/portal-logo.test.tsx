// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Feedback } from "../src/pages/Feedback";
import { PortalApp } from "../src/pages/Portal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c-logo", name: "App Co", mission: null, paused: false, agents: [] };
const PNG_B64 = "iVBORw0KGgo=";

describe("portal logo", () => {
  it("owner can add a logo, see the preview, and remove it", async () => {
    let hasLogo = false;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("portal-logo") && init?.method === "PUT") return (hasLogo = true), json({});
        if (url.includes("portal-logo") && init?.method === "DELETE") return (hasLogo = false), json({});
        if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: "t", portalTitle: null, portalIntro: null, hasLogo, drivers: [], areas: [] });
        if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
        return json([]);
      }),
    );
    render(<Feedback companies={[company]} companyId="c-logo" noteId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Feedback portal/ }));
    expect(await screen.findByText("Add logo")).toBeTruthy();
    expect(screen.getByText(/up to 256 KB/)).toBeTruthy();
    expect(screen.queryByAltText("Current portal logo")).toBeNull();

    const file = new File([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], "logo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Logo file"), { target: { files: [file] } });
    expect(await screen.findByAltText("Current portal logo")).toBeTruthy();
    expect(calls.some((c) => c.startsWith("PUT") && c.includes("portal-logo"))).toBe(true);
    expect(screen.getByText("Replace")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByAltText("Current portal logo")).toBeNull());
    expect(screen.getByText("Add logo")).toBeTruthy();
  });

  it("refuses a file over 256 KB without sending it", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: { method?: string }) => (url.includes("/feedback-settings") ? json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: "t", portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] }) : url.endsWith("/features") ? json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] }) : json([])));
    vi.stubGlobal("fetch", fetchMock);
    render(<Feedback companies={[{ ...company, id: "c-big" }]} companyId="c-big" noteId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Feedback portal/ }));
    await screen.findByText("Add logo");
    fireEvent.change(screen.getByLabelText("Logo file"), { target: { files: [new File([new Uint8Array(256 * 1024 + 1)], "big.png", { type: "image/png" })] } });
    expect((await screen.findByRole("alert")).textContent).toContain("256 KB");
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PUT")).toBe(false);
  });

  it("the portal page shows the logo beside the heading only when there is one", async () => {
    window.location.hash = "#tok";
    const portal = (hasLogo: boolean) =>
      vi.fn(async (url: string) =>
        url === "/api/portal/logo" ? new Response(Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png" } }) : json({ title: "What's next", intro: null, hasLogo, features: [] }),
      );
    vi.stubGlobal("fetch", portal(true));
    render(<PortalApp />);
    const img = await waitFor(() => document.querySelector("header img") ?? Promise.reject(new Error("no logo yet")));
    expect((img as HTMLImageElement).alt).toBe("");
    expect((img as HTMLImageElement).src.startsWith("data:image/png")).toBe(true);
    cleanup();
    vi.stubGlobal("fetch", portal(false));
    render(<PortalApp />);
    await screen.findByRole("heading", { name: "What's next" });
    expect(screen.queryByRole("img")).toBeNull();
  });
});
