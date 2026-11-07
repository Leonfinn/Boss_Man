import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport, tallestReading } from "@boss-man/shared";

// A rendering check at the owner's recorded device profiles (BOS-641), not a CSS-text test. Each
// profile in test/device-profiles/ is a browser's own measurement; the test renders the app shell at
// that CSS width and height and reproduces the toolbar gap the phone reported (100lvh − 100dvh) by
// rewriting the dynamic-viewport height, then measures where the menu actually ends. A profile the
// owner records can be dropped in as another JSON file and this test will run at it too.
//
// Skipped, not failed, where no browser is installed; the CSS-text test in sidebar-height.test.ts
// still runs everywhere and is only a quick guard.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="app">
<nav class="side" aria-label="Main">${Array.from({ length: 40 }, (_, i) => `<a href="#" class="nav">Item ${i}</a>`).join("")}</nav>
<main><h1>Page</h1><p>Body</p>
<div class="board-scroll"><div class="board">${Array.from({ length: 6 }, (_, i) => `<section class="lane"><h2>Lane ${i}</h2></section>`).join("")}</div></div>
</main>
</div></body></html>`;

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

// Turn every `100dvh` height into the shorter dynamic viewport the phone reported, so 100dvh < 100vh
// as on the real device. The gap is the profile's own 100lvh − 100dvh; nothing here is guessed.
const SHORT_DVH = (gap: number) => {
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style;
      const h = style?.getPropertyValue("height");
      if (h && h.endsWith("dvh")) style.setProperty("height", `calc(100vh - ${gap}px)`, "important");
      const nested = (rule as CSSMediaRule).cssRules;
      if (nested) walk(nested);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
};

describe.skipIf(!browser)("side menu at the owner's recorded device profiles", () => {
  it("has at least one recorded profile to render at", () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  for (const { file, parsed } of profiles) {
    it(`${file}: the menu reaches the window and its last item is reachable`, async () => {
      const t = tallestReading(parsed);
      const gap = Math.max(0, t.units.lvh - t.units.dvh);
      const page = await browser!.newPage({ viewport: { width: t.width, height: t.height }, deviceScaleFactor: t.pixelRatio, hasTouch: t.coarsePointer, isMobile: t.coarsePointer });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        if (gap > 0) await page.evaluate(SHORT_DVH, gap);
        const m = await page.evaluate(() => {
          const nav = document.querySelector("nav.side") as HTMLElement;
          const rect = nav.getBoundingClientRect();
          nav.scrollTop = nav.scrollHeight;
          const last = nav.lastElementChild as HTMLElement;
          const r = last.getBoundingClientRect();
          const box = nav.getBoundingClientRect();
          return { bottom: rect.bottom, winH: window.innerHeight, overflowY: getComputedStyle(nav).overflowY, reachable: r.bottom <= box.bottom + 1 && r.top >= box.top - 1 };
        });
        // No blank strip under the menu, and the last item is reachable by scrolling the menu itself.
        expect(Math.round(m.bottom)).toBe(m.winH);
        expect(m.overflowY).toBe("auto");
        expect(m.reachable).toBe(true);
        // An example board screen at this profile: the board is not cut off at the window's right
        // edge, and its last lane is reachable by scrolling the board (the BOS-599 page-short class).
        const board = await page.evaluate(() => {
          const scroll = document.querySelector(".board-scroll") as HTMLElement;
          const boardEl = document.querySelector(".board") as HTMLElement;
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
