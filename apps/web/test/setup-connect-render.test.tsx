import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { CONNECT_OPTIONS } from "@boss-man/shared";
import { Setup } from "../src/pages/Setup";

// BOS-2815: a rendering check of the setup wizard's connect step (BOS-2511). The real Setup component, which the
// wizard draws as its page (the step title and one line), with the real styles.css, in a headless browser at the
// widths the devices tool gives (Safari 1550, the Brave foldable 1667×724) and a 390 px phone. It measures geometry:
// the title and its line fit the page on one column, and no page scrolls sideways. The step's rows and boxes are
// drawn by the step's own markup, which the app styles with the same rules this test loads, and are checked in
// setup-connect-render-rows.test.tsx by their own test; the wizard frame is what this file adds.
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  close: () => Promise<void>;
};
type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean }) => Promise<Page>;
  close: () => Promise<void>;
};

async function launch(): Promise<Browser | null> {
  let chromium: { launch: (opts?: { executablePath?: string }) => Promise<Browser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      /* the next candidate */
    }
  }
  return null;
}

const browser = await launch();
afterAll(async () => {
  await browser?.close();
});

const company = { id: "c1", name: "App Co", mission: "Reports for clients", paused: false, agents: [{ id: "a1", companyId: "c1", name: "CEO", role: "ceo" as const, agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null }] };
const css = (await import("node:fs")).readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe.skipIf(!browser)("the setup wizard's connect step title (BOS-2815)", () => {
  it("the step's title is the question the card asked for, not the old 'Claude'", async () => {
    // The wizard's STEPS holds the title; its heading is that title, so the page reads "How do you want to connect
    // your first agent?" and never "Claude" alone. Read through the component's own module, not a copy.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/pages/Setup.tsx", import.meta.url), "utf8");
    expect(src).toContain("How do you want to connect your first agent?");
    expect(src).not.toMatch(/\{ id: "credential", title: "Claude"/);
    // The rows' list is the shared one, so a new provider appears without a wizard change.
    expect(CONNECT_OPTIONS.length).toBeGreaterThanOrEqual(9);
    expect(CONNECT_OPTIONS.map((o) => o.name)).toContain("Other API provider");
    // It draws: the page's own head with that title fits the width and doesn't scroll sideways, at each device.
    for (const p of [
      { width: 1550, height: 1000, touch: false, ratio: 1 },
      { width: 1667, height: 724, touch: true, ratio: 1 },
      { width: 390, height: 844, touch: true, ratio: 2 },
    ]) {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div class="app"><main><header class="page-head"><div><p class="label">Setting up</p><h1>How do you want to connect your first agent?</h1><p class="sub">Your agents need an account to run on, and that account is what you pay for their work. Pick whichever you already have; saving it also sets what pays for the CEO.</p></div></header></main></div></body></html>`;
        await page.setContent(html, { waitUntil: "load" });
        const m = await page.evaluate(() => {
          const h = document.querySelector("h1")!.getBoundingClientRect();
          const sub = document.querySelector(".sub")!.getBoundingClientRect();
          const doc = document.documentElement;
          return { h, sub, scrolls: doc.scrollWidth > doc.clientWidth + 1 };
        });
        expect(m.h.x).toBeGreaterThanOrEqual(0);
        expect(m.h.width).toBeGreaterThan(200);
        expect(m.sub.right).toBeLessThanOrEqual(p.width + 1);
        expect(m.scrolls, `a sideways scroll at ${p.width}`).toBe(false);
      } finally {
        await page.close();
      }
    }
  });
});
