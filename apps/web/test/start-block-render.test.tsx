import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { StartBlockBar } from "../src/components/StartBlock";

// BOS-2814: the red "Your agents can't start yet" bar, rendered with the real styles.css in a headless browser at the
// owner's two devices and a phone: the words and the Finish setting up button are on screen, the button sits inside the
// bar, and the bar doesn't scroll sideways. Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean }) => Promise<Page>; close: () => Promise<void> };

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

const scratch = process.env.BOSSMAN_SCRATCH;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(
  <StartBlockBar block={{ items: [{ id: "claude", label: "a Claude account" }, { id: "funding", label: "what pays for the CEO" }, { id: "runner", label: "a connected runner" }], noFunding: [] }} />,
)}</main></body></html>`;

const read = () => {
  const bar = document.querySelector<HTMLElement>("[data-testid=start-block-bar]")!;
  const btn = bar.querySelector<HTMLElement>("a.btn")!;
  const b = bar.getBoundingClientRect();
  const r = btn.getBoundingClientRect();
  return {
    text: bar.innerText,
    background: getComputedStyle(bar).backgroundColor,
    buttonVisible: r.width > 0 && r.height > 0,
    buttonInside: r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5,
    overflow: bar.scrollWidth - bar.clientWidth,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

const devices = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: "safari-1550", viewport: { width: 1550, height: 900 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("the start-block bar in a real browser (BOS-2814)", () => {
  for (const d of devices) {
    it(`${d.name}: words and button are on screen, red, and nothing runs off the bar`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got.text).toContain("Your agents can't start yet.");
        expect(got.text).toContain("a Claude account and what pays for the CEO and 1 more");
        expect(got.text).toContain("Finish setting up");
        expect(got.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(got.buttonVisible).toBe(true);
        expect(got.buttonInside).toBe(true);
        expect(got.overflow).toBeLessThanOrEqual(1);
        expect(got.pageOverflow).toBeLessThanOrEqual(1);
        if (scratch) await page.screenshot({ path: `${scratch}/start-block-${d.name}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
