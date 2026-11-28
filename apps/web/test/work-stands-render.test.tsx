import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { WorkStands } from "../src/components/WorkStands";

// BOS-2879: the strip at the top of the Dashboard. The owner read "14 in progress" above "2 agents running now" as 14
// agents working, and saw the dashed "Moving by itself" box wrap "50 merged, watching" onto a second line with an empty
// band above it. The strip now leads with "N agents working now", names the rest "tasks in progress", and the dashed box
// takes its own row: label and items on one baseline, same left edge as the pills, no empty band.
// Real styles.css in a headless browser at the owner's devices and a phone. Skipped where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
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

const scratch = process.env.BOSSMAN_SCRATCH;
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `work-stands-${name}.png`) : null);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main" style="padding:16px">${renderToStaticMarkup(
  <WorkStands working={2} counts={{ inProgress: 6, nextUp: 5, beingChecked: 6, watching: 50 }} hrefFor="#/board" />,
)}</main></body></html>`;

const read = () => {
  const box = (el: Element | null) => {
    const r = el?.getBoundingClientRect();
    return r ? { left: r.left, right: r.right, top: r.top, height: r.height } : null;
  };
  const strip = document.querySelector('[data-testid="work-stands"]')!;
  const quiet = strip.querySelector(".standing-quiet");
  return {
    text: (strip.textContent ?? "").replace(/\s+/g, " "),
    working: box(strip.querySelector('[data-testid="standing-working"]')),
    inProgress: box(strip.querySelector('[data-testid="standing-inProgress"]')),
    quiet: box(quiet),
    title: box(quiet?.querySelector(".standing-quiet-title") ?? null),
    items: [...(quiet?.querySelectorAll(".standing-item") ?? [])].map((e) => box(e)!),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-380", viewport: { width: 380, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("work stands strip in a real browser (BOS-2879)", () => {
  for (const d of devices) {
    it(`${d.name}: agents lead, tasks are named, the dashed box is one tidy block`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const g = await page.evaluate(read);
        expect(g.text).toContain("2 agents working now");
        expect(g.text).toContain("6 tasks in progress");
        // The pills and the dashed box share a left edge.
        expect(Math.abs(g.working!.left - g.quiet!.left)).toBeLessThanOrEqual(1);
        expect(g.inProgress!.top).toBeGreaterThanOrEqual(g.working!.top - 1);
        // The label leads the box and is inset from its border by the same amount at every device.
        expect(g.title!.left - g.quiet!.left).toBeGreaterThanOrEqual(10);
        expect(g.title!.left - g.quiet!.left).toBeLessThanOrEqual(14);
        // Every item sits inside the box.
        for (const it of g.items) {
          expect(it.left).toBeGreaterThanOrEqual(g.quiet!.left);
          expect(it.right).toBeLessThanOrEqual(g.quiet!.right + 1);
        }
        if (d.viewport.width > 640) {
          // Wide screens: label and all three items are one row, and the box is only as tall as that row (no empty band).
          const tops = new Set([g.title!.top, ...g.items.map((i) => i.top)].map((t) => Math.round(t / 2)));
          expect(tops.size).toBeLessThanOrEqual(2);
          expect(g.quiet!.height).toBeLessThanOrEqual(g.items[0]!.height + 4);
        }
        expect(g.overflow).toBeLessThanOrEqual(0);
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
