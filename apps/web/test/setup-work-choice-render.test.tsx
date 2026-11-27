import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { WorkChoice } from "../src/pages/Setup";

// BOS-2813: the "What will your team work on?" cards on setup step 2. Renders the real component with
// the real styles.css in a headless browser at a desktop and a 380px phone width and checks the two
// cards are both on screen, sit side by side on a desktop, stack on a phone and never run off the page.
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number } }) => Promise<Page>; close: () => Promise<void> };

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

describe.skipIf(!browser)("setup work choice, in a browser", () => {
  for (const [name, width] of [["desktop", 1280], ["phone", 380]] as const) {
    it(`shows both cards inside the page at ${name} width`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 800 } });
      const html = `<!doctype html><html><head><style>${css}</style></head><body><main class="card">${renderToStaticMarkup(<WorkChoice work="docs" onWork={() => {}} />)}</main></body></html>`;
      await page.setContent(html, { waitUntil: "load" });
      if (scratch) await page.screenshot({ path: `${scratch}/work-choice-${name}.png`, fullPage: true });
      const m = await page.evaluate(() => {
        const cards = [...document.querySelectorAll("label.card")].map((e) => e.getBoundingClientRect());
        return { cards: cards.map((r) => ({ left: r.left, right: r.right, top: r.top })), scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, text: document.body.innerText };
      });
      await page.close();
      expect(m.cards).toHaveLength(2);
      expect(m.text).toContain("Documents, research and writing");
      expect(m.text).toContain("Code in a git repository");
      expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
      for (const c of m.cards) expect(c.right).toBeLessThanOrEqual(m.innerW);
      if (width > 600) expect(Math.abs(m.cards[0]!.top - m.cards[1]!.top)).toBeLessThan(2);
      else expect(m.cards[1]!.top).toBeGreaterThan(m.cards[0]!.top + 10);
    });
  }
});
