import { afterAll, describe, expect, it } from "vitest";
import { launch, openApp, startVite, type Page } from "./real-page";

// A rendered-layout check for the side menu (BOS-599), not just a reading of the CSS text, and (BOS-966)
// on the REAL page: the app is mounted through Vite with `/api` answered from fixtures (the harness
// from BOS-962), so the menu measured here is the one the owner sees.
//
// The phone case: on Brave/Chrome on Android while the toolbar is showing, the dynamic viewport unit
// (100dvh) is shorter than the window (100vh). Chromium here has no toolbar, so 100dvh would equal
// 100vh and the bug would not show. We rewrite `dvh` heights as they load, exactly as the probe did,
// so the test reproduces the owner's condition: a menu sized to 100dvh then stops short of the bottom.
//
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).

const browser = await launch();
const server = await startVite();
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const skip = !browser || !server;

async function menu(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector("nav.side") as HTMLElement;
    const rect = nav.getBoundingClientRect();
    return { bottom: rect.bottom, height: rect.height, winH: window.innerHeight, scrollH: nav.scrollHeight, overflowY: getComputedStyle(nav).overflowY };
  });
}

describe.skipIf(skip)("side menu layout (rendered on the real page)", () => {
  it("reaches the window's bottom when 100dvh is shorter than the window, like a phone toolbar showing", async () => {
    // A short window (600px), so the menu's content is taller than it whatever the menu holds
    // (at 900px the BOS-1506 menu fits without scrolling and "taller content scrolls" had nothing to prove).
    const page = await openApp(browser!, server!, { width: 840, height: 600, pixelRatio: 2.6, hasTouch: true, sideCollapsed: true, toolbarGap: 130 });
    try {
      const m = await menu(page);
      // The menu's box must reach the window's bottom: no blank strip underneath.
      expect(Math.round(m.bottom)).toBe(m.winH);
      // It can still be as tall as the window (100vh), not the shorter dynamic viewport.
      expect(Math.round(m.height)).toBe(m.winH);
      // Since BOS-1506 the list scrolls in `.nav-scroll` and the pinned row (Log out) stays put below it,
      // so the box itself never overflows; the list inside must scroll when the window is short.
      const inner = await page.evaluate(() => {
        const nav = document.querySelector("nav.side") as HTMLElement;
        const list = nav.querySelector(".nav-scroll") as HTMLElement;
        const pinned = nav.querySelector(".side-pinned") as HTMLElement;
        const box = nav.getBoundingClientRect();
        const overflowY = getComputedStyle(list).overflowY;
        const tall = list.scrollHeight > list.clientHeight;
        // Rod's optional point: with 100vh the menu can run under the phone's toolbar, so the last
        // item must still be reachable by scrolling the list itself, and the pinned row stays in the box.
        list.scrollTop = list.scrollHeight;
        const items = list.querySelectorAll("a.nav, button.nav");
        const last = items[items.length - 1] as HTMLElement;
        const r = last.getBoundingClientRect();
        const lb = list.getBoundingClientRect();
        const p = pinned.getBoundingClientRect();
        return {
          overflowY,
          tall,
          reachable: r.bottom <= lb.bottom + 1 && r.top >= lb.top - 1,
          pinnedInside: p.bottom <= box.bottom + 1 && p.top >= box.top - 1,
        };
      });
      expect(inner.overflowY).toBe("auto");
      expect(inner.tall).toBe(true);
      expect(inner.reachable).toBe(true);
      expect(inner.pinnedInside).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("the pre-BOS-599 menu, sized to 100dvh, stops short of the window (so the test would have caught it)", async () => {
    // The old rule at >=641px was `height: 100dvh`. With the toolbar showing that is the shorter
    // dynamic viewport, so the menu (and its Log out) ended above the window's bottom.
    const page = await openApp(browser!, server!, { width: 840, height: 900, pixelRatio: 2.6, hasTouch: true, sideCollapsed: true, toolbarGap: 130 });
    try {
      await page.addStyleTag({ content: "@media (min-width: 641px) { .app > nav.side { height: calc(100vh - 130px) !important; } }" });
      const m = await menu(page);
      expect(m.winH - Math.round(m.bottom)).toBeGreaterThan(20);
    } finally {
      await page.close();
    }
  });

  it("leaves a 717, 760, 1024 and 1280px desktop window with the menu reaching the bottom", async () => {
    for (const width of [717, 760, 1024, 1280]) {
      const page = await openApp(browser!, server!, { width, height: 800, sideCollapsed: width <= 1180 });
      try {
        const m = await menu(page);
        expect(Math.round(m.bottom), `${width}px`).toBe(m.winH);
      } finally {
        await page.close();
      }
    }
  }, 60_000);
});
