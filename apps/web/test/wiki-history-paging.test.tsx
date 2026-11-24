// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Wiki } from "../src/pages/Wiki";

// BOS-496: a busy page has more versions than the first page the page carries; the owner must be
// able to page back to the oldest, so the history panel shows the total and loads older versions.

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const pages = [{ id: "w1", slug: "release-log", folder: "", title: "Release log", ticketId: null, updatedAt: new Date().toISOString(), updatedBy: "Ada" }];
const rev = (id: number) => ({ id: `r${id}`, createdAt: new Date(2026, 0, 1, 0, id).toISOString(), agent: "Ada", runId: null });

// The page carries the newest two; the full history is four, so two sit on the next page.
const DETAIL = { id: "w1", slug: "release-log", folder: "", title: "Release log", body: "Now", updatedAt: new Date().toISOString(), updatedBy: "Ada", revisions: [rev(4), rev(3)], revisionCount: 4, tickets: [] };

const setup = () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/wiki/release-log?versions=1&offset=2")) return new Response(JSON.stringify([rev(2), rev(1)]), { status: 200 });
      if (url.includes("/wiki/release-log")) return new Response(JSON.stringify(DETAIL), { status: 200 });
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

describe("wiki history paging (BOS-496)", () => {
  it("shows the whole history's count and pages back to the oldest version", async () => {
    setup();
    render(<Wiki companies={[company]} companyId="c1" slug="release-log" go={() => {}} />);
    // The button counts every version, not just the first page the page carries.
    // Testing-library waits 1 s by default; the page loads lazily and GitHub's runners are several times slower,
    // so each wait gets a 15 s deadline (it returns as soon as the element is there).
    const wait = { timeout: 15_000 };
    const toggle = await screen.findByRole("button", { name: "History (4)" }, wait);
    fireEvent.click(toggle);
    expect(await screen.findByRole("button", { name: /Show older versions \(2 more\)/ }, wait)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Show older versions/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Show older versions/ })).toBeNull(), wait);
    // All four versions are listed, oldest included.
    const items = screen.getByLabelText("History").querySelectorAll("li");
    expect(items).toHaveLength(4);
  }, 45_000); // vitest's own 5 s test limit would cut the waits above short
});
