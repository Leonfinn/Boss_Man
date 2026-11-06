import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

// A rendered-layout check for the side menu (BOS-599), not just a reading of the CSS text. It loads
// the real stylesheet into a real Chromium and measures where the menu actually ends.
//
// The phone case: on Brave/Chrome on Android while the toolbar is showing, the dynamic viewport
// unit (100dvh) is shorter than the window (100vh). Chromium here has no toolbar, so 100dvh would
// equal 100vh and the bug would not show. We rewrite `dvh` heights as they load, exactly as the
// probe did, so the test reproduces the owner's condition.
//
// Skipped, not failed, where no browser is installed (the CI job has none today): the CSS-text test
// in sidebar-height.test.ts still runs everywhere.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// The shell the menu lives in: `<div class="app"><nav class="side">…</nav><main>…</main></div>`,
// with enough menu items to be taller than the window so its own scrolling shows too.
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="app">
<nav class="side" aria-label="Main">${Array.from({ length: 40 }, (_, i) => `<a href="#">Item ${i}</a>`).join("")}</nav>
<main><h1>Page</h1><p>Body</p></main>
</div></body></html>`;

// Turn every `height: …dvh` into the shorter dynamic viewport the phone reports, so 100dvh < 100vh
// as on the real device. Rules inside `@media` are walked too (the menu rule lives in one). The
// test runs this explicitly after the stylesheet has loaded, before it measures.
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

// The bits of Playwright's API this test uses. Playwright is a global tool here, not a project
// dependency, so its own types aren't resolvable; this keeps typecheck honest without adding it.
type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
  close: () => Promise<void>;
};
type Browser = {
  version: () => string;
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
  const tries: Array<string | undefined> = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    undefined, // Playwright's own download, if present
  ];
  for (const executablePath of tries) {
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

describe.skipIf(!browser)("side menu layout (rendered)", () => {
  it("reaches the window's bottom when 100dvh is shorter than the window, like a phone toolbar showing", async () => {
    const page = await browser!.newPage({ viewport: { width: 840, height: 900 }, deviceScaleFactor: 2.6, hasTouch: true, isMobile: true });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      await page.evaluate(SHORT_DVH, 130);
      const m = await page.evaluate(() => {
        const nav = document.querySelector("nav.side") as HTMLElement;
        const rect = nav.getBoundingClientRect();
        return { bottom: rect.bottom, height: rect.height, winH: window.innerHeight, scrollH: nav.scrollHeight, overflowY: getComputedStyle(nav).overflowY };
      });
      // The menu's box must reach the window's bottom: no blank strip underneath.
      expect(Math.round(m.bottom)).toBe(m.winH);
      // It can still be as tall as the window (100vh), not the shorter dynamic viewport.
      expect(Math.round(m.height)).toBe(m.winH);
      // Taller content scrolls inside the menu rather than spilling past the window.
      expect(m.overflowY).toBe("auto");
      expect(m.scrollH).toBeGreaterThan(m.height);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("leaves a 717, 760, 1024 and 1280px desktop window with the menu reaching the bottom", async () => {
    for (const width of [717, 760, 1024, 1280]) {
      const page = await browser!.newPage({ viewport: { width, height: 800 } });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        const m = await page.evaluate(() => {
          const rect = (document.querySelector("nav.side") as HTMLElement).getBoundingClientRect();
          return { bottom: rect.bottom, winH: window.innerHeight };
        });
        expect(Math.round(m.bottom), `${width}px`).toBe(m.winH);
      } finally {
        await page.close();
      }
    }
  }, 60_000);
});
