// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";

// BOS-2259: the wiki page view and a feature's own page carry the same "Copy link" button as Ticket and Run.

const copyText = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("../src/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

import { Wiki } from "../src/pages/Wiki";
import { Features } from "../src/pages/Features";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const here = (hash: string) => `${window.location.origin}${window.location.pathname}${hash}`;

beforeEach(() => copyText.mockReset().mockResolvedValue(true));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function showWiki() {
  const page = { id: "p1", slug: "index", folder: "", title: "Index", body: "hello", updatedAt: new Date().toISOString(), updatedBy: "Brian", revisions: [], tickets: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("/wiki/index") ? json(page) : json([]))));
  window.location.hash = "#/wiki/c1/index";
  render(<Wiki companies={[{ id: "c1", name: "App Co", agents: [] } as never]} companyId="c1" slug="index" go={() => {}} />);
}

function showFeature() {
  const row = { id: "f1", companyId: "c1", areaId: null, parentId: null, title: "Dark mode", description: null, status: "in_progress", effort: null, driverScores: {}, milestoneId: null, portalVisible: false, keepOffPortal: false, keepOffReason: null, publicSummary: null, publicTitle: null, showPublicly: false, priorityOne: false, createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:00:00Z", releasedAt: null, demand: 0, insightCount: 0, customerCount: 0, value: 0, demandPart: 0, priority: 0, tickets: { total: 0, done: 0, items: [] }, portal: { onPortal: false, reason: null } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [row] });
      if (url.startsWith("/api/features/")) return json({ feature: row, drivers: [], settings: { demandWeight: 1 }, maxDemand: 0, subfeatures: [], insights: [], tickets: [] });
      if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      return json([]);
    }),
  );
  window.location.hash = "#/features/c1/f1";
  const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [], projects: [] };
  render(<Features companies={[company]} companyId="c1" featureId="f1" go={() => {}} />);
}

describe("Copy link on wiki and feature pages (BOS-2259)", () => {
  it("a wiki page has Copy link next to Edit, and it copies that page's address", async () => {
    showWiki();
    const btn = await screen.findByRole("button", { name: "Copy link" });
    expect(btn.parentElement!.parentElement!.contains(screen.getByRole("button", { name: "Edit" }))).toBe(true);
    await act(async () => void fireEvent.click(btn));
    expect(copyText).toHaveBeenCalledWith(here("#/wiki/c1/index"));
    expect(btn.textContent).toBe("Copied");
  });

  it("a feature's own page has Copy link in its header, and it copies that feature's address", async () => {
    showFeature();
    const btn = await screen.findByRole("button", { name: "Copy link" });
    expect(btn.closest("header")!.querySelector("h1")!.textContent).toBe("Dark mode");
    await act(async () => void fireEvent.click(btn));
    expect(copyText).toHaveBeenCalledWith(here("#/features/c1/f1"));
    expect(btn.textContent).toBe("Copied");
  });

  it.each([
    ["wiki page", showWiki, "#/wiki/c1/index"],
    ["feature page", showFeature, "#/features/c1/f1"],
  ] as const)("on a %s, a refused copy shows the address selected, to copy by hand", async (_name, show, hash) => {
    copyText.mockResolvedValue(false);
    show();
    const btn = await screen.findByRole("button", { name: "Copy link" });
    await act(async () => void fireEvent.click(btn));
    const field = screen.getByLabelText("Page address") as HTMLInputElement;
    expect(field.value).toBe(here(hash));
    expect(field.readOnly).toBe(true);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
    expect(screen.getByText(/Couldn't copy here/)).toBeTruthy();
  });
});
