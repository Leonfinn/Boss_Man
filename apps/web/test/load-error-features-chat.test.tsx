// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Features } from "../src/pages/Features";
import { ChatPage } from "../src/pages/Chat";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

describe("Features and Chat: a failed load says so (BOS-1889)", () => {
  it("Features shows an error with Retry, then the empty text only after a good empty answer", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/features")) return fail ? json({ error: "boom" }, 500) : json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
        return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      }),
    );
    render(<Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />);
    await screen.findByText(/Couldn't load your features/);
    expect(screen.queryByText(/No features yet/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/No features yet/);
  });

  it("a feature's page shows the loader while its data is on the way, not a blank page (BOS-2065)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<Features companies={[company]} companyId="c1" featureId="f1" go={() => {}} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(container.querySelector(".loader")).not.toBeNull();
  });

  it("the priority settings panel shows its error when the settings fail to load (BOS-2065)", async () => {
    let panelOpen = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
        if (panelOpen) return json({ error: "settings boom" }, 500);
        return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      }),
    );
    render(<Features companies={[{ ...company, id: "c2" }]} companyId="c2" featureId={undefined} go={() => {}} />);
    const toggle = await screen.findByRole("button", { name: "Criteria and areas" });
    panelOpen = true;
    fireEvent.click(toggle);
    await screen.findByText(/Couldn't load the priority settings: settings boom/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    panelOpen = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Couldn't load the priority settings/)).toBeNull());
  });

  it("a feature's page shows 'Couldn't load the feature' with Retry on a server error, and keeps the 404 block (BOS-2294)", async () => {
    let status = 500;
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "feature boom" }, status)));
    render(<Features companies={[{ ...company, id: "c3" }]} companyId="c3" featureId="f9" go={() => {}} />);
    await screen.findByText(/Couldn't load the feature: feature boom/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    cleanup();
    status = 404;
    render(<Features companies={[{ ...company, id: "c4" }]} companyId="c4" featureId="f10" go={() => {}} />);
    await screen.findByText(/Feature not found/);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("Chat shows an error with Retry when the team fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
    render(<ChatPage companies={[company]} companyId="c1" agentId={undefined} go={() => {}} onChanged={() => {}} />);
    await screen.findByText(/Couldn't load the team/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
