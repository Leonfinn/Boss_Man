import { readdirSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport, tallestReading } from "@boss-man/shared";
import { launch, openApp, startVite } from "./real-page";

// A rendering check at the owner's recorded device profiles (BOS-641), not a CSS-text test, and (BOS-966)
// on the REAL page: the app is mounted through Vite with `/api` answered from fixtures (the harness from
// BOS-962), so the menu and board measured are the owner's. Each profile in test/device-profiles/ is a
// browser's own measurement; the test renders the app at that CSS width and height and reproduces the
// toolbar gap the phone reported (100lvh − 100dvh) by rewriting the dynamic-viewport height, then measures
// where the menu actually ends. A profile the owner records can be dropped in as another JSON file and this
// test will run at it too.
//
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).

const browser = await launch();
const server = await startVite();
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const profiles = (() => {
  const dir = new URL("./device-profiles/", import.meta.url);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, parsed: DeviceReport.parse(JSON.parse(readFileSync(new URL(f, dir), "utf8"))) }))
      .filter((p) => p.parsed.readings.some((r) => r.afterScroll));
  } catch {
    return [];
  }
})();

const skip = !browser || !server;

describe.skipIf(skip)("side menu at the owner's recorded device profiles (real page)", () => {
  it("has at least one recorded profile to render at", () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  for (const { file, parsed } of profiles) {
    it(`${file}: the menu reaches the window and its last item is reachable`, async () => {
      const t = tallestReading(parsed);
      // The gap the test imitates is the profile's own 100lvh − 100dvh, from its tallest reading
      // (lvh can't be shorter than dvh, so this is never clamped away).
      const gap = t.units.lvh - t.units.dvh;
      expect(gap).toBeGreaterThanOrEqual(0);
      const page = await openApp(browser!, server!, { width: t.width, height: t.height, pixelRatio: t.pixelRatio, hasTouch: t.coarsePointer, sideCollapsed: true, toolbarGap: gap });
      try {
        const m = await page.evaluate(() => {
          const nav = document.querySelector("nav.side") as HTMLElement;
          const rect = nav.getBoundingClientRect();
          nav.scrollTop = nav.scrollHeight;
          // The last reachable item is the Log out button in the footer (inside the nav groups).
          const last = (nav.querySelector(".foot .logout") ?? nav.lastElementChild) as HTMLElement;
          const r = last.getBoundingClientRect();
          const box = nav.getBoundingClientRect();
          return { bottom: rect.bottom, winH: window.innerHeight, overflowY: getComputedStyle(nav).overflowY, reachable: r.bottom <= box.bottom + 1 && r.top >= box.top - 1 };
        });
        // No blank strip under the menu, and the last item is reachable by scrolling the menu itself.
        expect(Math.round(m.bottom)).toBe(m.winH);
        expect(m.overflowY).toBe("auto");
        expect(m.reachable).toBe(true);
        // The real board screen at this profile: the board is not cut off at the window's right edge,
        // and its last lane is reachable by scrolling the board (the BOS-599 page-short class).
        const board = await page.evaluate(() => {
          const scroll = document.querySelector(".board-scroll") as HTMLElement;
          const boardEl = scroll.querySelector(".board") as HTMLElement;
          const lastLane = boardEl.lastElementChild as HTMLElement;
          scroll.scrollLeft = scroll.scrollWidth;
          const b = lastLane.getBoundingClientRect();
          const s = scroll.getBoundingClientRect();
          return { fits: s.right <= window.innerWidth + 1, reachable: b.right <= s.right + 1 && b.left >= s.left - 1 };
        });
        expect(board.fits).toBe(true);
        expect(board.reachable).toBe(true);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
