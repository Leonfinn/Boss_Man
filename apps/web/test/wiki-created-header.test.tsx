// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Wiki } from "../src/pages/Wiki";

// BOS-2466: the header says when a page was created and by whom, and History says how many people edited it.

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const pages = [{ id: "w1", slug: "guide", folder: "", title: "Guide", ticketId: null, updatedAt: new Date().toISOString(), updatedBy: "Zippy" }];
const base = { id: "w1", slug: "guide", folder: "", title: "Guide", body: "Now", updatedAt: new Date().toISOString(), updatedBy: "Zippy", createdAt: "2026-11-03T10:00:00.000Z", revisions: [], tickets: [] };

const setup = (detail: object) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/wiki/guide")) return new Response(JSON.stringify(detail), { status: 200 });
      if (url.includes("/wiki-semantic")) return new Response(JSON.stringify({ enabled: false, baseUrl: "", model: "", dims: 768, secretId: null }), { status: 200 });
      if (url.includes("/api/secrets")) return new Response("[]", { status: 200 });
      if (url.includes("/wiki")) return new Response(JSON.stringify(pages), { status: 200 });
      return new Response("[]", { status: 200 });
    }),
  );
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wait = { timeout: 15_000 };

describe("wiki page header (BOS-2466)", () => {
  it("shows who created the page and how many people edited it", async () => {
    setup({ ...base, createdBy: "Florence", editors: 4, revisionCount: 12 });
    render(<Wiki companies={[company]} companyId="c1" slug="guide" go={() => {}} />);
    expect(await screen.findByText(/Created .* by Florence · Changed .* by Zippy/, {}, wait)).toBeTruthy();
    expect(screen.getByRole("button", { name: "History (12 versions, 4 people)" })).toBeTruthy();
  }, 45_000);

  it("shows the date alone for a page with no revisions", async () => {
    setup({ ...base, createdBy: null, editors: 0, revisionCount: 0 });
    render(<Wiki companies={[company]} companyId="c1" slug="guide" go={() => {}} />);
    const line = await screen.findByText(/Created .* · Changed/, {}, wait);
    expect(line.textContent?.split("Changed")[0]).not.toContain(" by ");
    expect(screen.getByRole("button", { name: "History (0)" })).toBeTruthy();
  }, 45_000);
});
