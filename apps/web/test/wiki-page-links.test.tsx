// @vitest-environment jsdom
// BOS-2366: under a wiki page, a Links section (links to, missing pages, linked from), and the delete confirm counts backlinks.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Wiki } from "../src/pages/Wiki";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(extra: { links?: string[]; missingLinks?: string[]; linkedFrom?: string[] }) {
  const page = { id: "p1", slug: "spec", folder: "", title: "Spec", body: "Body text.", updatedAt: new Date().toISOString(), updatedBy: "Brian", revisions: [], tickets: [], ...extra };
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.includes("/wiki/spec") ? json(page) : json([]))));
  render(<Wiki companies={[{ id: "c1", name: "App Co", agents: [] } as never]} companyId="c1" slug="spec" go={() => {}} />);
}

describe("wiki page Links section (BOS-2366)", () => {
  it("lists links and backlinks as page links and marks missing pages as plain text", async () => {
    open({ links: ["glossary"], missingLinks: ["nowhere"], linkedFrom: ["eng/roadmap", "notes"] });
    const section = await screen.findByRole("region", { name: "Links" });
    expect(within(section).getByText("Links to:")).toBeTruthy();
    expect(within(section).getByRole("link", { name: "glossary" }).getAttribute("href")).toBe("#/wiki/c1/glossary");
    expect(within(section).getByRole("link", { name: "eng/roadmap" }).getAttribute("href")).toBe("#/wiki/c1/eng/roadmap");
    expect(within(section).getByRole("link", { name: "notes" })).toBeTruthy();
    expect(within(section).getByText("nowhere (no such page)")).toBeTruthy();
    expect(within(section).queryByRole("link", { name: /nowhere/ })).toBeNull();
  });

  it("is hidden when the page links nowhere and nothing links to it", async () => {
    open({ links: [], missingLinks: [], linkedFrom: [] });
    await screen.findByText("Body text.");
    expect(screen.queryByRole("region", { name: "Links" })).toBeNull();
  });

  it("the delete confirm says how many pages link here", async () => {
    open({ linkedFrom: ["a", "b"] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(confirm.mock.calls[0]![0]).toContain("2 pages link here.");
  });

  it("the delete confirm says nothing about links when none point here", async () => {
    open({ linkedFrom: [] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(confirm.mock.calls[0]![0]).not.toContain("link here");
  });
});
