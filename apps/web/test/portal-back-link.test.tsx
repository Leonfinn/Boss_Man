// @vitest-environment jsdom
// BOS-967: the portal's optional "← Back to …" links, and the owner's setting that turns them on.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Feedback } from "../src/pages/Feedback";
import { PortalApp } from "../src/pages/Portal";

// jsdom's import.meta.url isn't a file URL, so find the stylesheet from the package root vitest runs in.
const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number } }) => Promise<Page>; close: () => Promise<void> };

async function launch(): Promise<Browser | null> {
  let chromium: { launch: (opts?: { executablePath?: string }) => Promise<Browser> };
  try {
    chromium = createRequire(resolve(process.cwd(), "package.json"))("playwright").chromium;
  } catch {
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      // try the next one
    }
  }
  return null;
}

const browser = await launch();
afterAll(async () => {
  await browser?.close();
});

// The real portal component rendered to markup with the owner's setting on or off, measured in a
// headless browser at the design's desktop (1280) and phone (390) widths. This is the rendered check
// BOS-967 asks for (criterion 2), not a CSS-text test.
async function portalMarkup(back: { url: string; text: string } | null): Promise<string> {
  window.location.hash = "#tok";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/portal" ? json({ title: "What's next", intro: null, hasLogo: false, back, features: [{ id: "f1", title: "Dark mode", description: null, stage: "planned", myVote: null }] }) : json({}))));
  render(<PortalApp />);
  await screen.findByRole("heading", { name: "What's next" });
  const body = document.body.innerHTML;
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main.portal { padding: 16px; }
</style></head><body>${body}</body></html>`;
}

type Rendered = {
  barTop: number | null;
  barHeight: number | null;
  linkCount: number;
  footAfterNotes: boolean;
  hitsFirst: boolean;
  scrollWidth: number;
  innerWidth: number;
};

const measure = () => {
  const bar = document.querySelector(".portal-back-bar") as HTMLElement | null;
  const foot = document.querySelector(".portal-back-foot") as HTMLElement | null;
  const links = Array.from(document.querySelectorAll("a.portal-back")) as HTMLAnchorElement[];
  const notes = document.querySelector("main.portal p.muted:last-of-type") as HTMLElement | null;
  // Tab from the top of the document: the back link should be the first focusable element.
  const all = Array.from(document.querySelectorAll("body *")) as HTMLElement[];
  const firstFocusable = all.find((el) => el.tabIndex >= 0 || el.matches("a[href],button,input,textarea,select")) ?? null;
  return {
    barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
    barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : null,
    linkCount: links.length,
    footAfterNotes: foot && notes ? foot.getBoundingClientRect().top >= notes.getBoundingClientRect().bottom - 1 : false,
    hitsFirst: links.length > 0 && firstFocusable === links[0],
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
};

describe.skipIf(!browser)("portal back link renders at phone and desktop widths (BOS-967)", () => {
  for (const { label, width, height } of [
    { label: "desktop 1280", width: 1280, height: 800 },
    { label: "phone 390", width: 390, height: 844 },
  ]) {
    it(`${label}: the back bar is the first thing on the page and the link repeats at the bottom`, async () => {
      const page = await browser!.newPage({ viewport: { width, height } });
      try {
        await page.setContent(await portalMarkup({ url: "https://bossman.example/", text: "Boss Man" }), { waitUntil: "load" });
        const m = (await page.evaluate(measure)) as Rendered;
        expect(m.linkCount).toBe(2);
        expect(m.barTop).toBe(0);
        expect(m.barHeight).toBeGreaterThanOrEqual(48);
        expect(m.footAfterNotes).toBe(true);
        expect(m.hitsFirst).toBe(true);
        expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  it("desktop 1280: with no address there is no bar and no bottom link", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.setContent(await portalMarkup(null), { waitUntil: "load" });
      const m = (await page.evaluate(measure)) as Rendered;
      expect(m.linkCount).toBe(0);
      expect(m.barTop).toBeNull();
      expect(m.barHeight).toBeNull();
    } finally {
      await page.close();
    }
  }, 30_000);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c-back", name: "App Co", mission: null, paused: false, agents: [] };
const settings = (extra: Record<string, unknown> = {}) => ({ demandWeight: 1, ceoTriage: false, portalEnabled: true, portalToken: "t", portalTitle: "What's next", portalIntro: null, portalBackUrl: null, portalBackText: null, hasLogo: false, drivers: [], areas: [], ...extra });

describe("portal back link", () => {
  it("shows a bar at the top and a link at the bottom when the owner set an address", async () => {
    window.location.hash = "#tok";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/portal" ? json({ title: "What's next", intro: null, hasLogo: false, back: { url: "https://bossman.example/", text: "Boss Man" }, features: [] }) : json({}))));
    render(<PortalApp />);
    await screen.findByRole("heading", { name: "What's next" });
    const links = screen.getAllByRole("link", { name: /Back to Boss Man/ });
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute("href")).toBe("https://bossman.example/");
      expect(a.getAttribute("target")).toBeNull();
    }
    // One is in the top bar, ahead of the page, and one is after the last line.
    const bar = document.querySelector(".portal-back-bar");
    expect(bar?.contains(links[0]!)).toBe(true);
    expect(document.querySelector(".portal-back-foot")?.contains(links[1]!)).toBe(true);
    const main = document.querySelector("main.portal")!;
    expect(main.textContent).toContain("Votes are remembered in this browser");
    // The bottom link comes after the "Votes are remembered" line.
    const last = [...main.querySelectorAll("p")].at(-1)!;
    expect(last.closest(".portal-back-foot")).toBeTruthy();
  });

  it("shows no bar or bottom link when the address is not set", async () => {
    window.location.hash = "#tok";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/portal" ? json({ title: "What's next", intro: null, hasLogo: false, back: null, features: [] }) : json({}))));
    render(<PortalApp />);
    await screen.findByRole("heading", { name: "What's next" });
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector(".portal-back-bar")).toBeNull();
    expect(document.querySelector(".portal-back-foot")).toBeNull();
    // The page itself still starts with the heading, as it did before the setting existed.
    expect(document.querySelector("main.portal > header")).toBeTruthy();
  });

  it("the owner gets the error for an address without https://, and Save stays off", async () => {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => (url.includes("/feedback-settings") ? json(settings()) : url.endsWith("/features") ? json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] }) : json([])));
    vi.stubGlobal("fetch", fetchMock);
    render(<Feedback companies={[company]} companyId="c-back" noteId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Feedback portal/ }));
    const url = await screen.findByLabelText("Link back to your website (optional)");
    fireEvent.change(url, { target: { value: "example.com" } });
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a full web address that starts with https://");
    const save = screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest("form")!);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "PATCH" && String(c[1].body).includes("backUrl"))).toBe(false);
  });

  it("the owner saves an https address and a short link text together", async () => {
    let saved: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes("/feedback-settings")) return json(settings(saved));
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
      if (init?.method === "PATCH" && url.endsWith("/portal")) {
        saved = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        return json(settings({ portalBackUrl: saved.backUrl, portalBackText: saved.backText }));
      }
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Feedback companies={[company]} companyId="c-back" noteId={undefined} go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /Feedback portal/ }));
    fireEvent.change(await screen.findByLabelText("Link back to your website (optional)"), { target: { value: "https://bossman.example/" } });
    fireEvent.change(screen.getByLabelText("Link text (optional)"), { target: { value: "Boss Man" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);
    await waitFor(() => expect(saved).toEqual({ backUrl: "https://bossman.example/", backText: "Boss Man" }));
    expect(await screen.findByText("Back link saved.")).toBeTruthy();
  });
});
