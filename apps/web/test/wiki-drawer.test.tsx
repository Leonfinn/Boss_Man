// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Wiki } from "../src/pages/Wiki";

// jsdom has no matchMedia; the drawer turns on for a narrow window and off for a wide one.
const setWidth = (width: number) => {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity);
    return { matches: width <= max, media: query, addEventListener: () => {}, removeEventListener: () => {} };
  });
};

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const pages = [
  { id: "w1", slug: "research/one", folder: "Research", title: "One", ticketId: null, updatedAt: new Date().toISOString(), updatedBy: "Ada" },
  { id: "w2", slug: "research/two", folder: "Research", title: "Two", ticketId: null, updatedAt: new Date().toISOString(), updatedBy: "Ada" },
  { id: "w3", slug: "top", folder: "", title: "Top", ticketId: null, updatedAt: new Date().toISOString(), updatedBy: "Ada" },
];

const setup = (width: number) => {
  setWidth(width);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/wiki/research/one")) return new Response(JSON.stringify({ id: "w1", slug: "research/one", folder: "Research", title: "One", body: "Hello", updatedAt: new Date().toISOString(), updatedBy: "Ada", revisions: [], tickets: [] }), { status: 200 });
      if (url.includes("/wiki-semantic")) return new Response(JSON.stringify({ enabled: false, baseUrl: "", model: "", dims: 768, secretId: null }), { status: 200 });
      if (url.includes("/api/secrets")) return new Response("[]", { status: 200 });
      if (url.includes("/wiki")) return new Response(JSON.stringify(pages), { status: 200 });
      return new Response("[]", { status: 200 });
    }),
  );
};

beforeEach(() => setWidth(390));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("wiki page list drawer", () => {
  it("starts hidden behind a labelled menu button on a phone, and opens over the page", async () => {
    setup(390);
    render(<Wiki companies={[company]} companyId="c1" slug="research/one" go={() => {}} />);
    const toggle = await screen.findByRole("button", { name: "Show pages" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("wiki-pages");
    expect(screen.getByLabelText("Pages").getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide pages" }).getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByLabelText("Pages");
    expect(list.className).toContain("open");
    expect(list.hasAttribute("aria-hidden")).toBe(false);
    // The open page is still marked.
    const current = (await screen.findAllByRole("link", { name: /One/ })).find((a) => a.getAttribute("aria-current") === "page");
    expect(current?.getAttribute("href")).toBe("#/wiki/c1/research/one");
  });

  it("closes on Escape and on tapping the dimmed page, and keeps a folder the reader opened", async () => {
    setup(390);
    render(<Wiki companies={[company]} companyId="c1" slug="research/one" go={() => {}} />);
    const toggle = await screen.findByRole("button", { name: "Show pages" });
    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Show pages" }).getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Show pages" }));
    const folder = () => [...document.querySelectorAll(".wiki-list details")].find((d) => d.querySelector("summary")!.textContent!.startsWith("Research")) as HTMLDetailsElement;
    expect(folder().open).toBe(true);
    fireEvent.click(folder().querySelector("summary")!);
    expect(folder().open).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Show pages" }));
    // Reopened: the folder stays shut as the reader left it.
    await waitFor(() => expect(folder().open).toBe(false));
  });

  it("keeps the list as it is, with no menu button, on a desktop width", async () => {
    setup(1400);
    render(<Wiki companies={[company]} companyId="c1" slug="research/one" go={() => {}} />);
    await screen.findByRole("link", { name: /Top/ });
    expect(screen.queryByRole("button", { name: "Show pages" })).toBeNull();
    expect(screen.getByLabelText("Pages").className).not.toContain("wiki-drawer");
  });
});
