import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { QueuedBehindLine } from "../src/components/QueuedBehindLine";

// BOS-2911: a Ready ticket whose assignee is at their limit says "Queued behind BOS-a, BOS-b" in the card's line.
// Rendered with the real styles.css in Chromium at 380, 724 and 1667 px. Skipped where no browser is installed.

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
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main"><section class="lane" style="max-width:100%">${renderToStaticMarkup(
  <article className="ticket" data-ticket-id="t1">
    <h3>Add the export button</h3>
    <QueuedBehindLine refs={["BOS-4", "BOS-9", "BOS-1203", "BOS-1204", "BOS-1205"]} who="Penfold" />
  </article>,
)}</section></main></body></html>`;

describe("QueuedBehindLine", () => {
  it("says nothing without blockers", () => {
    expect(renderToStaticMarkup(<QueuedBehindLine refs={null} who="Penfold" />)).toBe("");
    expect(renderToStaticMarkup(<QueuedBehindLine refs={[]} who="Penfold" />)).toBe("");
  });
  it("names the tickets in order", () => {
    expect(renderToStaticMarkup(<QueuedBehindLine refs={["BOS-4", "BOS-9"]} who="Penfold" />)).toContain("Queued behind BOS-4, BOS-9");
  });
});

describe.skipIf(!browser)("Queued behind line in a real browser (BOS-2911)", () => {
  for (const width of [380, 724, 1667]) {
    it(`${width}px: the line shows inside the card and nothing overflows`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 500 } });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(() => {
          const card = document.querySelector("article.ticket")!.getBoundingClientRect();
          const line = document.querySelector('[data-testid="board-queued-behind"]') as HTMLElement;
          const r = line.getBoundingClientRect();
          return { text: line.innerText, visible: r.width > 0 && r.height > 0, inside: r.left >= card.left - 1 && r.right <= card.right + 1, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        expect(got.text).toContain("Queued behind BOS-4, BOS-9, BOS-1203, BOS-1204, BOS-1205");
        expect(got.visible).toBe(true);
        expect(got.inside).toBe(true);
        expect(got.overflow).toBeLessThanOrEqual(1);
        if (scratch) await page.screenshot({ path: `${scratch}/board-queued-behind-${width}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
