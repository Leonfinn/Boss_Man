import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

// BOS-2826: the setup wizard frame (progress bar, step list, Next and Skip). Loads the real styles.css
// in a headless browser: on a phone (380px, touch) the bar shows and the step list is gone, the step
// buttons are at least 44px tall under a coarse pointer, and nothing runs off the page. On a desktop
// the step list stays. Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Opts = { viewport: { width: number; height: number }; hasTouch?: boolean; isMobile?: boolean };
type Browser = { newPage: (opts?: Opts) => Promise<Page>; close: () => Promise<void> };

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

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main>
<header class="page-head"><div><p class="label">Setting up · step 2 of 7</p><progress class="setup-bar" aria-label="Setup progress" max="7" value="2"></progress><h1>What will your team work on?</h1><p class="sub">Pick the kind of work your team does.</p></div></header>
<ol class="stepper"><li class="done"><button class="linkish">✓ Your company</button></li><li aria-current="step"><button class="linkish">2 What will your team work on?</button></li><li><button class="linkish">3 Claude account</button></li><li><button class="linkish">4 Your agents' workspace</button></li></ol>
<section class="card setup-card"><div class="setup-nav"><button class="btn">Back</button><button class="btn primary">Next: Claude account</button><button class="linkish">Skip this step</button></div></section>
</main></body></html>`;

describe.skipIf(!browser)("setup frame, in a browser", () => {
  for (const [name, opts] of [
    ["desktop", { viewport: { width: 1440, height: 900 } }],
    ["phone", { viewport: { width: 380, height: 800 }, hasTouch: true, isMobile: true }],
  ] as const) {
    it(`lays out the bar, step list and buttons at ${name} width`, async () => {
      const page = await browser!.newPage(opts);
      await page.setContent(html, { waitUntil: "load" });
      if (scratch) await page.screenshot({ path: `${scratch}/setup-frame-${name}.png`, fullPage: true });
      const m = await page.evaluate(() => {
        const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const stepper = document.querySelector(".stepper") as HTMLElement;
        return {
          stepperShown: getComputedStyle(stepper).display !== "none",
          bar: { w: box(".setup-bar").width, h: box(".setup-bar").height },
          next: box(".setup-nav .btn.primary").height,
          skip: box(".setup-nav .linkish").height,
          stepButton: stepper.offsetParent ? box(".stepper .linkish").height : 0,
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
        };
      });
      await page.close();
      expect(m.bar.w).toBeGreaterThan(100);
      expect(m.bar.h).toBeGreaterThan(0);
      expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
      if (name === "phone") {
        expect(m.stepperShown).toBe(false);
        expect(m.next).toBeGreaterThanOrEqual(44);
        expect(m.skip).toBeGreaterThanOrEqual(44);
      } else {
        expect(m.stepperShown).toBe(true);
      }
    });
  }
});
