import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport, tallestReading } from "@boss-man/shared";
import { launch, openApp, startVite, type Page } from "./real-page";

// A rendering check at the owner's recorded device profiles (BOS-641), not a CSS-text test, and (BOS-966)
// on the REAL page: the app is mounted through Vite with `/api` answered from fixtures, the same harness
// BOS-962 used to catch a fault a hand-written board could never show. The board's sideways scroller must
// run from the side menu to the window edge, so the screen clips the columns instead of the page's side
// padding (BOS-807). The page's side padding used to inset the scroller and leave an empty strip at each
// edge (about 33px on the foldable). At rest the first column must still line up with the page heading,
// and the last one keeps the same gutter.
//
// The "old rule" case injects the pre-BOS-807 `.board-scroll` declaration over the real page and asserts
// the strip comes back, so this test is proven to catch the fault it guards.
//
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).

const browser = await launch();
const server = await startVite();
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

// The owner's measurement from the devices tool (BOS-807): the unfolded foldable, Brave, 724 CSS px wide
// and tall, pixel ratio 3, no toolbar gap. It is held as a DeviceReport, so every figure the browser
// renders at is the recorded one rather than a guessed size. The 724px width is where BOS-807 was
// reported (the foldable folded), so the strip the test guards shows there; the owner's two recorded
// profiles (below) are wider, and the edge-to-edge rule must hold at those too.
const foldable: DeviceReport = DeviceReport.parse({
  label: "Unfolded foldable · Brave (BOS-807)",
  browser: "Brave",
  fingerprint: "bos-807-foldable",
  readings: [{ width: 724, height: 724, pixelRatio: 3, coarsePointer: true, displayMode: "standalone", units: { vh: 724, dvh: 724, svh: 724, lvh: 724, visual: 724 }, afterScroll: false }],
});

// The owner's two screens, exactly as the devices tool recorded them (BOS-641). Both are desktop-width,
// so the menu sits beside the page; the board still runs from the menu to the window edge.
const recorded: Array<{ label: string; t: { width: number; height: number; pixelRatio: number; coarsePointer: boolean } }> = [
  { label: "Brave · 1667px · touch", t: { width: 1667, height: 724, pixelRatio: 3, coarsePointer: true } },
  { label: "Safari mouse", t: { width: 1550, height: 1594, pixelRatio: 2, coarsePointer: false } },
];

// The pre-BOS-807 rule, exactly as it shipped: no negative margin, so `main`'s padding insets the
// scroller and clips the columns.
const OLD_RULE = ".board-scroll { margin-inline: 0 !important; padding-inline: 0 !important; }";

function measure(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector("nav.side") as HTMLElement;
    const scroll = document.querySelector(".board-scroll") as HTMLElement;
    const heading = document.querySelector(".page-head h1") as HTMLElement;
    const boardEl = scroll.querySelector(".board") as HTMLElement;
    const firstLane = boardEl.querySelector(".lane") as HTMLElement;
    const lastLane = boardEl.lastElementChild as HTMLElement;
    const s = scroll.getBoundingClientRect();
    const h = heading.getBoundingClientRect();
    const f = firstLane.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    return {
      scrollLeft: s.left,
      scrollRight: s.right,
      headingLeft: h.left,
      firstLaneLeft: f.left,
      lastLaneRight: lastLane.getBoundingClientRect().right,
      scrolls: scroll.scrollWidth > scroll.clientWidth,
      windowWidth: window.innerWidth,
      navRight: n.right,
      navWidth: n.width,
      navPosition: getComputedStyle(nav).position,
      navCollapsed: nav.classList.contains("collapsed"),
    };
  });
}

const skip = !browser || !server;
const open = (opts: Parameters<typeof openApp>[2]) => openApp(browser!, server!, opts);

describe.skipIf(skip)("board scroll area runs from the menu to the window edge (BOS-807, real page)", () => {
  it("has the recorded foldable profile to render at", () => {
    expect(foldable.readings.length).toBeGreaterThan(0);
  });

  it("reproduces the reported strip with the old rule on the real page (so the test would have caught it)", async () => {
    const t = tallestReading(foldable);
    const page = await open({ width: t.width, height: t.height, pixelRatio: t.pixelRatio, hasTouch: t.coarsePointer, sideCollapsed: true });
    try {
      await page.addStyleTag({ content: OLD_RULE });
      const m = await measure(page);
      // The old scroller starts well right of the menu and stops short of the window edge.
      expect(m.scrollLeft - m.navRight).toBeGreaterThan(20);
      expect(m.windowWidth - m.scrollRight).toBeGreaterThan(20);
    } finally {
      await page.close();
    }
  });

  it("at the foldable, collapsed: columns are clipped by the menu and the window edge", async () => {
    const t = tallestReading(foldable);
    const page = await open({ width: t.width, height: t.height, pixelRatio: t.pixelRatio, hasTouch: t.coarsePointer, sideCollapsed: true });
    try {
      const m = await measure(page);
      expect(m.navCollapsed, "the menu starts as the icon strip on this foldable").toBe(true);
      // The scroller touches the menu on the left and the window on the right: no empty strip.
      expect(Math.abs(m.scrollLeft - m.navRight)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.scrollRight - m.windowWidth)).toBeLessThanOrEqual(2);
      // At rest the first column still lines up with the page heading (the gutter).
      expect(Math.abs(m.firstLaneLeft - m.headingLeft)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it("keeps a gutter after the last column when the board fits without scrolling", async () => {
    // Five lanes of at least 200px fit a 2400px window, so the trailing gutter is on screen (a board that
    // does scroll ends flush with the edge, as any scroller does).
    const page = await open({ width: 2400, height: 900, sideCollapsed: false });
    try {
      const m = await measure(page);
      expect(m.scrolls).toBe(false);
      expect(m.scrollRight - m.lastLaneRight).toBeGreaterThanOrEqual(30);
      expect(m.firstLaneLeft - m.scrollLeft).toBeGreaterThanOrEqual(30);
    } finally {
      await page.close();
    }
  });

  it("at the foldable, expanded: the same, with the wider menu (a drawer over the page)", async () => {
    const t = tallestReading(foldable);
    const page = await open({ width: t.width, height: t.height, pixelRatio: t.pixelRatio, hasTouch: t.coarsePointer, sideCollapsed: false });
    try {
      const m = await measure(page);
      // At 724px the expanded menu is a drawer fixed over the page, so the scroller still runs to the
      // window edge; the heading keeps its inset and the board follows it.
      expect(m.navCollapsed).toBe(false);
      expect(m.navPosition).toBe("fixed");
      expect(m.navWidth).toBeGreaterThan(150);
      expect(Math.abs(m.scrollRight - m.windowWidth)).toBeLessThanOrEqual(2);
      expect(m.headingLeft).toBe(64);
      expect(Math.abs(m.firstLaneLeft - m.headingLeft)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it("at the owner's recorded screens: the board still runs from the menu to the window edge", async () => {
    for (const { label, t } of recorded) {
      const page = await open({ width: t.width, height: t.height, pixelRatio: t.pixelRatio, hasTouch: t.coarsePointer });
      try {
        const m = await measure(page);
        expect(Math.abs(m.scrollLeft - m.navRight), `${label}: scroller starts at the menu`).toBeLessThanOrEqual(1);
        expect(Math.abs(m.scrollRight - m.windowWidth), `${label}: scroller reaches the window edge`).toBeLessThanOrEqual(2);
        // The board follows the page's gutter at rest, so the first column meets the heading.
        expect(Math.abs(m.firstLaneLeft - m.headingLeft), `${label}: first lane meets the heading`).toBeLessThanOrEqual(1);
      } finally {
        await page.close();
      }
    }
  }, 60_000);

  it("at a desktop width: the content column sits between the menu and the window, not edge to edge", async () => {
    const page = await open({ width: 1440, height: 900, sideCollapsed: false });
    try {
      const m = await measure(page);
      // On a desktop the page keeps its side padding on the content (the heading is inset 40px), and
      // the board still runs from the menu to the window edge without widening the page.
      expect(m.headingLeft - m.navRight).toBeGreaterThan(30);
      expect(Math.abs(m.scrollLeft - m.navRight)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.scrollRight - m.windowWidth)).toBeLessThanOrEqual(2);
      expect(Math.abs(m.firstLaneLeft - m.headingLeft)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });
});
