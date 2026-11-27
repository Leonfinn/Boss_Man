import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

// BOS-2828: the "More options" fold on the task page and the sideways-scroll hint over the board.
// Loads the real styles.css in a headless browser and measures: the closed fold is one short line, the open one
// shows its rows, and the hint stays inside the page at phone width. Skipped, not failed, where no browser is installed.
// Known gap: it measures hand-written markup with the real stylesheet, not the Ticket and Board components, so it
// would not notice Ticket.tsx dropping the fold. Those are covered by jsdom tests (not-found-and-empty-states,
// wiki-recent) and by the before/after screenshots on the ticket.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
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

const html = (open: boolean) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
<p class="board-more muted" role="note" id="hint">More columns to the right: scroll sideways →</p>
<aside class="card"><details class="more-options" id="fold"${open ? " open" : ""}><summary>More options</summary>
<dl><dt>Risk</dt><dd>Low</dd><dt>Size</dt><dd>3 points</dd><dt>Watcher</dt><dd>Off</dd></dl></details></aside></body></html>`;

describe.skipIf(!browser)("More options fold and board hint", () => {
  for (const width of [380, 1550]) {
    it(`at ${width}px: closed is one short line, open shows the rows, nothing runs off`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 800 } });
      await page.setContent(html(false), { waitUntil: "load" });
      const closed = await page.evaluate(() => document.getElementById("fold")!.getBoundingClientRect().height);
      await page.setContent(html(true), { waitUntil: "load" });
      const m = await page.evaluate(() => {
        const f = document.getElementById("fold")!.getBoundingClientRect();
        const h = document.getElementById("hint")!.getBoundingClientRect();
        return { open: f.height, right: Math.max(f.right, h.right), vw: document.documentElement.clientWidth };
      });
      expect(closed).toBeLessThan(60);
      expect(m.open).toBeGreaterThan(closed + 40);
      expect(m.right).toBeLessThanOrEqual(m.vw);
      await page.close();
    });
  }
});
