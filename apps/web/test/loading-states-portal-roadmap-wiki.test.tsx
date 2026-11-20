// @vitest-environment jsdom
// BOS-2102: Portal, Roadmap and Wiki say "Loading…" while data is on its way, and the wiki list says when it failed.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { PortalApp } from "../src/pages/Portal";
import { Roadmap } from "../src/pages/Roadmap";
import { Wiki } from "../src/pages/Wiki";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
// The Loader waits one second before showing its words, so the findBy timeout is longer than that.
const slow = { timeout: 4000 };
const never = () => vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

describe("loading states (BOS-2102)", () => {
  it("portal shows Loading instead of a blank page", async () => {
    window.location.hash = "#tok";
    never();
    render(<PortalApp />);
    expect(await screen.findByText(/Loading the feedback page/, {}, slow)).toBeTruthy();
  });

  it("roadmap features tab shows Loading", async () => {
    never();
    render(<Roadmap companies={[company]} tab="features" go={() => {}} />);
    expect(await screen.findByText(/Loading the features/, {}, slow)).toBeTruthy();
  });

  it("roadmap timeline tab shows Loading", async () => {
    never();
    render(<Roadmap companies={[company]} tab="timeline" go={() => {}} />);
    expect(await screen.findByText(/Loading the timeline/, {}, slow)).toBeTruthy();
  });

  it("wiki page shows Loading", async () => {
    never();
    render(<Wiki companies={[company]} companyId={company.id} slug="some/page" go={() => {}} />);
    expect(await screen.findByText(/Loading the page/, {}, slow)).toBeTruthy();
  });

  it("wiki company brief shows Loading", async () => {
    never();
    render(<Wiki companies={[company]} companyId={company.id} slug={undefined} go={() => {}} />);
    expect(await screen.findByText(/Loading the company brief/, {}, slow)).toBeTruthy();
  });

  it("a failed wiki list says so", async () => {
    const other = { ...company, id: "c2" }; // a path no earlier test left a pending shared request on
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (/\/wiki(\?|$)/.test(String(url)) ? new Response(JSON.stringify({ message: "boom" }), { status: 400 }) : new Response(String(url).endsWith("/brief") ? JSON.stringify({ markdown: "Brief" }) : "[]", { status: 200 }))),
    );
    render(<Wiki companies={[other]} companyId={other.id} slug={undefined} go={() => {}} />);
    expect(await screen.findByText(/Couldn't load the page list: boom/)).toBeTruthy();
  });
});
