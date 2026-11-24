// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Wiki, stalePages } from "../src/pages/Wiki";

const DAY = 86_400_000;
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const row = (i: number, ageDays: number, by: string | null = null) => ({
  id: `w${i}`,
  slug: `p${i}`,
  folder: i === 0 ? "Runbooks" : "",
  title: `Page ${i}`,
  ticketId: null,
  updatedAt: new Date(Date.now() - ageDays * DAY).toISOString(),
  updatedBy: by,
});

function stubPages(pages: ReturnType<typeof row>[]) {
  vi.stubGlobal("matchMedia", () => ({ matches: false, media: "", addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/wiki-semantic")) return new Response(JSON.stringify({ enabled: false, baseUrl: "", model: "", dims: 768, secretId: null }), { status: 200 });
      if (url.includes("/api/secrets")) return new Response("[]", { status: 200 });
      if (url.includes("/wiki/p5")) return new Response(JSON.stringify({ id: "w5", slug: "p5", folder: "", title: "Page 5", body: "Hello", updatedAt: new Date().toISOString(), updatedBy: null, revisions: [], tickets: [] }), { status: 200 });
      if (url.includes("/wiki")) return new Response(JSON.stringify(pages), { status: 200 });
      return new Response("[]", { status: 200 });
    }),
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("stalePages", () => {
  it("keeps pages older than 30 days, oldest first, with whole days", () => {
    const now = Date.now();
    const out = stalePages(
      [
        { updatedAt: new Date(now - 45 * DAY).toISOString() },
        { updatedAt: new Date(now - 29 * DAY).toISOString() },
        { updatedAt: new Date(now - 90 * DAY).toISOString() },
        { updatedAt: "not a date" },
      ],
      now,
    );
    expect(out.map((x) => x.days)).toEqual([90, 45]);
  });
});

describe("wiki Not changed in 30 days", () => {
  it("lists stale pages with folder, age and who, and shows 20 then all", async () => {
    stubPages([row(0, 45, "Ada"), ...Array.from({ length: 24 }, (_, i) => row(i + 1, 50 + i)), row(99, 2)]);
    render(<Wiki companies={[company]} companyId="c1" slug="p5" go={() => {}} />);
    const block = await waitFor(() => {
      const el = document.querySelector(".wiki-stale");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(block.querySelector("summary")!.textContent).toBe("Not changed in 30 days (25)");
    expect(block.querySelectorAll("li a")).toHaveLength(20);
    fireEvent.click(screen.getByText("Show all 25"));
    expect(block.querySelectorAll("li a")).toHaveLength(25);
    const last = [...block.querySelectorAll("li a")].at(-1)!;
    expect(last.textContent).toContain("Runbooks · 45 days ago by Ada");
  });

  it("shows (0) when every page is fresh", async () => {
    stubPages([row(1, 1), row(2, 3)]);
    render(<Wiki companies={[company]} companyId="c1" slug="p5" go={() => {}} />);
    await waitFor(() => expect(document.querySelector(".wiki-stale summary")?.textContent).toBe("Not changed in 30 days (0)"));
    expect(document.querySelector(".wiki-stale")!.textContent).toContain("No page is older than 30 days.");
  });
});
