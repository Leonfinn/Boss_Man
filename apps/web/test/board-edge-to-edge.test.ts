import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport, tallestReading } from "@boss-man/shared";

// A rendering check at the owner's recorded device profiles (BOS-641), not a CSS-text test. The
// board's sideways scroller must run from the side menu to the window edge, so the screen clips the
// columns instead of the page's side padding (BOS-807). The page's side padding used to inset the
// scroller and leave an empty strip at each edge (about 33px on the foldable). At rest the first
// column must still line up with the page heading, and the last one keeps the same gutter.
//
// Skipped, not failed, where no browser is installed.

const realCss = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// The old rule, exactly as it shipped before BOS-807: no negative margin, so `main`'s padding insets
// the scroller and clips the columns.
const newRule = `.board-scroll { overflow-x: auto; overflow-y: hidden; padding-bottom: 8px; margin-inline: calc(var(--board-gutter) * -1); padding-inline: var(--board-gutter); }`;
const oldCss = realCss.replace(newRule, ".board-scroll { overflow-x: auto; overflow-y: hidden; padding-bottom: 8px; }");
if (oldCss === realCss) throw new Error("the BOS-807 board-scroll rule was not found in styles.css");

const HTML = (css: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="app side-collapsed">
<nav class="side collapsed" aria-label="Main">${Array.from({ length: 12 }, (_, i) => `<a href="#" class="nav"><span class="nav-label">Item ${i}</span></a>`).join("")}</nav>
<main><header class="page-head"><div><p class="label">Company · project</p><h1>Kanban</h1></div></header>
<div class="board-bar"><div><button type="button" class="btn primary">Add task</button></div></div>
<p>Rename a column with its pencil. Agents always see the fixed state.</p>
<div class="board-scroll"><div class="board">${Array.from({ length: 8 }, (_, i) => `<section class="lane"><h2>Lane ${i}</h2><article class="ticket">A card in lane ${i}</article></section>`).join("")}</div></div>
</main>
</div></body></html>`;

// The owner's measurement from the devices tool (BOS-807): the unfolded foldable, Brave, ~724 CSS px
// wide, pixel ratio 3, no toolbar gap. It is held here as a DeviceReport, so every figure the headless
// browser renders at is the recorded one rather than a guessed size.
const foldable: DeviceReport = DeviceReport.parse({
  label: "Unfolded foldable · Brave (BOS-807)",
  browser: "Brave",
  fingerprint: "bos-807-foldable",
  readings: [
    {
      width: 724,
      height: 724,
      pixelRatio: 3,
      coarsePointer: true,
      displayMode: "standalone",
      units: { vh: 724, dvh: 724, svh: 724, lvh: 724, visual: 724 },
      afterScroll: false,
    },
  ],
});

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
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
      // try the next one
    }
  }
  return null;
}

const browser = await launch();
afterAll(async () => {
  await browser?.close();
});

const keptProfiles = (() => {
  const dir = new URL("./device-profiles/", import.meta.url);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, parsed: DeviceReport.parse(JSON.parse(readFileSync(new URL(f, dir), "utf8"))) }));
  } catch {
    return [];
  }
})();

function measure(page: Page) {
  return page.evaluate(() => {
    const scroll = document.querySelector(".board-scroll") as HTMLElement;
    const heading = document.querySelector(".page-head h1") as HTMLElement;
    const firstLane = scroll.querySelector(".lane") as HTMLElement;
    const lastLane = scroll.lastElementChild!.lastElementChild as HTMLElement;
    const s = scroll.getBoundingClientRect();
    const h = heading.getBoundingClientRect();
    const f = firstLane.getBoundingClientRect();
    const scrolls = scroll.scrollWidth > scroll.clientWidth;
    return {
      scrollLeft: s.left,
      scrollRight: s.right,
      headingLeft: h.left,
      firstLaneLeft: f.left,
      lastLaneRight: lastLane.getBoundingClientRect().right,
      scrolls,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      navRight: (document.querySelector("nav.side") as HTMLElement).getBoundingClientRect().right,
    };
  });
}

async function render(opts: { width: number; height: number; pixelRatio: number; touch: boolean; css: string }) {
  const page = await browser!.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: opts.pixelRatio, hasTouch: opts.touch, isMobile: opts.touch });
  try {
    await page.setContent(HTML(opts.css), { waitUntil: "load" });
    return await measure(page);
  } finally {
    await page.close();
  }
}

describe.skipIf(!browser)("board scroll area runs from the menu to the window edge (BOS-807)", () => {
  it("has the recorded foldable profile to render at", () => {
    expect(foldable.readings.length).toBeGreaterThan(0);
  });

  it("reproduces the reported strip with the old rule (so the test would have caught it)", async () => {
    const t = tallestReading(foldable);
    const m = await render({ width: t.width, height: t.height, pixelRatio: t.pixelRatio, touch: t.coarsePointer, css: oldCss });
    // The old scroller starts well right of the menu and stops short of the window edge.
    expect(m.scrollLeft - m.navRight).toBeGreaterThan(20);
    expect(m.windowWidth - m.scrollRight).toBeGreaterThan(20);
  });

  it("at the foldable, collapsed: columns are clipped by the menu and the window edge", async () => {
    const t = tallestReading(foldable);
    const m = await render({ width: t.width, height: t.height, pixelRatio: t.pixelRatio, touch: t.coarsePointer, css: realCss });
    // The scroller touches the menu on the left and the window on the right: no empty strip.
    expect(Math.abs(m.scrollLeft - m.navRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.scrollRight - m.windowWidth)).toBeLessThanOrEqual(2);
    // At rest the first column still lines up with the page heading (the gutter).
    expect(Math.abs(m.firstLaneLeft - m.headingLeft)).toBeLessThanOrEqual(1);
  });

  it("keeps a gutter after the last column when the board fits without scrolling", async () => {
    // The harness has eight columns, so a wide enough window fits them and the trailing gutter is on
    // screen (a board that does scroll ends flush with the edge, as any scroller does).
    const m = await render({ width: 2400, height: 900, pixelRatio: 1, touch: false, css: realCss });
    expect(m.scrolls).toBe(false);
    expect(m.scrollRight - m.lastLaneRight).toBeGreaterThanOrEqual(30);
    expect(m.firstLaneLeft - m.scrollLeft).toBeGreaterThanOrEqual(30);
  });

  it("at the foldable, expanded: the same, with the wider menu (a drawer over the page)", async () => {
    const t = tallestReading(foldable);
    const page = await browser!.newPage({ viewport: { width: t.width, height: t.height }, deviceScaleFactor: t.pixelRatio, hasTouch: t.coarsePointer, isMobile: t.coarsePointer });
    try {
      await page.setContent(HTML(realCss).replace('class="app side-collapsed"', 'class="app"').replace('class="side collapsed"', 'class="side"'), { waitUntil: "load" });
      const m = await page.evaluate(() => {
        const nav = document.querySelector("nav.side") as HTMLElement;
        const scroll = document.querySelector(".board-scroll") as HTMLElement;
        const heading = document.querySelector(".page-head h1") as HTMLElement;
        const s = scroll.getBoundingClientRect();
        const firstLane = scroll.querySelector(".lane") as HTMLElement;
        return {
          scrollRight: s.right,
          windowWidth: window.innerWidth,
          scrollLeft: s.left,
          navRight: nav.getBoundingClientRect().right,
          navWidth: nav.getBoundingClientRect().width,
          navPosition: getComputedStyle(nav).position,
          // The heading does not move when the menu opens: the board's gutter follows the page.
          headingLeft: heading.getBoundingClientRect().left,
          // The first lane lands on the heading, behind the drawer and its 24px of page padding.
          firstLaneLeft: firstLane.getBoundingClientRect().left,
        };
      });
      // At 724px the expanded menu is a drawer fixed over the page, so the scroller still runs to the
      // window edge; the heading keeps its inset and the board follows it.
      expect(m.navPosition).toBe("fixed");
      expect(m.navWidth).toBeGreaterThan(150);
      expect(Math.abs(m.scrollRight - m.windowWidth)).toBeLessThanOrEqual(2);
      expect(m.headingLeft).toBe(64);
      expect(Math.abs(m.firstLaneLeft - m.headingLeft)).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });

  it("at a desktop width: the content column sits between the menu and the window, not edge to edge", async () => {
    const m = await render({ width: 1440, height: 900, pixelRatio: 1, touch: false, css: realCss });
    // On a desktop the page keeps its side padding on the content (the heading is inset 40px), and
    // the board still runs from the menu to the window edge without widening the page.
    expect(m.headingLeft - m.navRight).toBeGreaterThan(30);
    expect(Math.abs(m.scrollLeft - m.navRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.scrollRight - m.windowWidth)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.firstLaneLeft - m.headingLeft)).toBeLessThanOrEqual(1);
  });
});

describe("kept device profiles", () => {
  it("still render with the board reaching both edges", async () => {
    if (!browser) return;
    for (const { file, parsed } of keptProfiles) {
      const t = tallestReading(parsed);
      const page = await browser!.newPage({ viewport: { width: t.width, height: t.height }, deviceScaleFactor: t.pixelRatio, hasTouch: t.coarsePointer, isMobile: t.coarsePointer });
      try {
        await page.setContent(HTML(realCss), { waitUntil: "load" });
        const m = await page.evaluate(() => {
          const scroll = document.querySelector(".board-scroll") as HTMLElement;
          const nav = document.querySelector("nav.side") as HTMLElement;
          const s = scroll.getBoundingClientRect();
          return { scrollLeft: s.left, scrollRight: s.right, navRight: nav.getBoundingClientRect().right, windowWidth: window.innerWidth };
        });
        expect(Math.abs(m.scrollLeft - m.navRight), `${file}: scroller starts at the menu`).toBeLessThanOrEqual(1);
        expect(Math.abs(m.scrollRight - m.windowWidth), `${file}: scroller reaches the window edge`).toBeLessThanOrEqual(2);
      } finally {
        await page.close();
      }
    }
  }, 30_000);
});
