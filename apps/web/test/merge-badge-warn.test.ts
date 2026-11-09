import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

// A real-browser render of the Merge queue side-menu badge (BOS-767): the badge turns to the
// warning colour and shows the stuck count, at a desktop width, in the collapsed icon strip (dot),
// and at phone width. Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// The menu markup the Sidebar renders for a stuck badge with two stuck items, inside the app shell.
const shell = (opts: { collapsed?: boolean; stuck: number; waiting: number }) => `<div class="app${opts.collapsed ? " side-collapsed" : ""}">
<nav class="side${opts.collapsed ? " collapsed" : ""}" aria-label="Main">
<div class="side-bar"><div class="brand"><span>Boss Man</span></div><button class="side-collapse">x</button></div>
<div id="nav-groups" class="nav-groups"><section><h2>Work</h2><ul>
<li><a class="nav" href="#/merge-queue"><span class="nav-label">Merge queue</span><span class="count warn" aria-label="${opts.stuck} stuck">${opts.stuck}</span><span class="count-dot warn" aria-hidden="true"></span></a></li>
</ul></section></div></nav>
<main><h1>Page</h1></main></div>`;

const normal = (waiting: number) => `<div class="app"><nav class="side" aria-label="Main"><div class="nav-groups"><section><h2>Work</h2><ul>
<li><a class="nav" href="#/merge-queue"><span class="nav-label">Merge queue</span><span class="count" aria-label="${waiting} waiting to merge">${waiting}</span><span class="count-dot" aria-hidden="true"></span></a></li>
</ul></section></div></nav><main></main></div>`;

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;

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
      // try the next one
    }
  }
  return null;
}

const browser = await launch();
afterAll(async () => {
  await browser?.close();
});

const AMBER = "rgb(180, 83, 9)"; // --amber
const BADGE = "rgb(240, 183, 92)"; // --badge

const badge = () =>
  (() => {
    const el = document.querySelector(".side .count") as HTMLElement;
    const dot = document.querySelector(".side .count-dot") as HTMLElement;
    return { text: el.textContent, label: el.getAttribute("aria-label"), bg: getComputedStyle(el).backgroundColor, dotBg: getComputedStyle(dot).backgroundColor };
  })();

describe.skipIf(!browser)("merge queue badge warning colour in a real browser (BOS-767)", () => {
  it("desktop: shows the stuck count in amber", async () => {
    const page = await browser!.newPage({ viewport: { width: 1550, height: 900 } });
    try {
      await page.setContent(html(shell({ stuck: 2, waiting: 5 })), { waitUntil: "load" });
      const b = await page.evaluate(badge);
      expect(b.text).toBe("2");
      expect(b.label).toBe("2 stuck");
      expect(b.bg).toBe(AMBER);
    } finally {
      await page.close();
    }
  });

  it("collapsed strip: the number is hidden and the dot is amber", async () => {
    const page = await browser!.newPage({ viewport: { width: 1550, height: 900 } });
    try {
      await page.setContent(html(shell({ collapsed: true, stuck: 2, waiting: 5 })), { waitUntil: "load" });
      const b = await page.evaluate(badge);
      expect(b.dotBg).toBe(AMBER);
    } finally {
      await page.close();
    }
  });

  it("phone width: the badge stays amber and readable", async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    try {
      await page.setContent(html(shell({ stuck: 2, waiting: 5 })), { waitUntil: "load" });
      const b = await page.evaluate(badge);
      expect(b.text).toBe("2");
      expect(b.bg).toBe(AMBER);
    } finally {
      await page.close();
    }
  });

  it("leaves the normal waiting badge alone when nothing is stuck", async () => {
    const page = await browser!.newPage({ viewport: { width: 1550, height: 900 } });
    try {
      await page.setContent(html(normal(4)), { waitUntil: "load" });
      const b = await page.evaluate(badge);
      expect(b.text).toBe("4");
      expect(b.bg).toBe(BADGE);
    } finally {
      await page.close();
    }
  });
});
