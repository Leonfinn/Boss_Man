import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { TaskList } from "../src/pages/Features";

// The feature page's status chips in a real browser with the real styles.css: they wrap on a phone
// (no sideways scroll), and each is at least 24px tall (WCAG 2.2 rule 2.5.8). Skipped where no browser is installed.

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
const states = ["backlog", "ready", "in_progress", "blocked", "review", "done"];
const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `Made-up task number ${i}`, state: states[i % 6]!, outcome: i === 5 ? "cancelled" : null, assignee: null }));
const html = `<!doctype html><html><head><style>${css}</style></head><body><main style="padding:12px"><section class="card"><p class="label">Tasks delivering it</p>${renderToStaticMarkup(<TaskList tasks={tasks} />)}</section></main></body></html>`;

describe.skipIf(!browser)("feature task chips in a real browser", () => {
  for (const [name, width] of [["desktop", 1280], ["phone", 380]] as const) {
    it(`${name} (${width}px): chips wrap, stay on screen and are tall enough`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 800 } });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const m = await page.evaluate(() => {
          const chips = [...document.querySelectorAll("button.chip")].map((b) => b.getBoundingClientRect());
          return { count: chips.length, minH: Math.min(...chips.map((r) => r.height)), maxRight: Math.max(...chips.map((r) => r.right)), scrollW: document.documentElement.scrollWidth, vw: window.innerWidth };
        });
        expect(m.count).toBe(9);
        expect(m.minH).toBeGreaterThanOrEqual(24);
        expect(m.maxRight).toBeLessThanOrEqual(m.vw);
        expect(m.scrollW).toBeLessThanOrEqual(m.vw);
        if (scratch) await page.screenshot({ path: join(scratch, `feature-task-chips-${name}.png`), fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
