// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Wiki } from "../src/pages/Wiki";

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
// 12 pages; p0 is the oldest and p11 the newest.
const pages = Array.from({ length: 12 }, (_, i) => ({
  id: `w${i}`,
  slug: `p${i}`,
  folder: i === 11 ? "Research" : "",
  title: `Page ${i}`,
  ticketId: null,
  updatedAt: new Date(Date.UTC(2026, 10, 1, 12, i)).toISOString(),
  updatedBy: i === 11 ? "Ada" : null,
}));

beforeEach(() => {
  localStorage.clear();
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const block = () => document.querySelector(".wiki-recent") as HTMLDetailsElement | null;

describe("wiki Recently changed", () => {
  it("lists the 10 newest pages, newest first, with folder and who", async () => {
    render(<Wiki companies={[company]} companyId="c1" slug="p5" go={() => {}} />);
    await waitFor(() => expect(block()).not.toBeNull());
    const links = [...block()!.querySelectorAll("li a")];
    expect(links).toHaveLength(10);
    expect(links[0]!.textContent).toContain("Page 11");
    expect(links[0]!.textContent).toContain("Research");
    expect(links[0]!.textContent).toContain("by Ada");
    expect(links[9]!.textContent).toContain("Page 2");
  });

  it("remembers a collapse, and is hidden while searching", async () => {
    render(<Wiki companies={[company]} companyId="c1" slug="p5" go={() => {}} />);
    await waitFor(() => expect(block()).not.toBeNull());
    expect(block()!.open).toBe(true);
    fireEvent.click(block()!.querySelector("summary")!);
    await waitFor(() => expect(localStorage.getItem("wiki-recent-open")).toBe("closed"));
    cleanup();
    render(<Wiki companies={[company]} companyId="c1" slug="p5" go={() => {}} />);
    await waitFor(() => expect(block()).not.toBeNull());
    expect(block()!.open).toBe(false);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "x" } });
    expect(block()).toBeNull();
  });
});
