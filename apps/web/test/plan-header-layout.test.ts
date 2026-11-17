import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite";

// A rendering check of the Plan page header (BOS-1525, BOS-1657), in headless Chromium: the real Plan
// page (bundled from src) with the real styles.css. It catches a change that pushes the chart back
// down on the owner's foldable, and a compact header that shrinks Refresh or the fold bar on touch.
// Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  waitForSelector: (sel: string, opts?: { timeout?: number }) => Promise<unknown>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  close: () => Promise<void>;
};
type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; hasTouch?: boolean; isMobile?: boolean }) => Promise<Page>;
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

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: "silent",
    root: fileURLToPath(new URL("..", import.meta.url)),
    define: { "process.env.NODE_ENV": '"production"' },
    esbuild: { jsx: "automatic", jsxDev: false },
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      lib: { entry: fileURLToPath(new URL("./fixtures/plan-header-entry.tsx", import.meta.url)), formats: ["iife"], name: "PlanHeader", fileName: "p" },
    },
  })) as unknown as { output: { type: string; code?: string }[] }[] | { output: { type: string; code?: string }[] };
  const outputs = Array.isArray(out) ? out.flatMap((o) => o.output) : out.output;
  return outputs.filter((o) => o.type === "chunk").map((o) => o.code).join("\n");
}

const js = browser ? await bundle() : "";
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

const measure = () => {
  const h = (sel: string) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect().height;
  const graph = document.querySelector('[aria-label="Dependency graph"]') as HTMLElement;
  return { chartTop: graph.getBoundingClientRect().top, innerHeight: window.innerHeight, refresh: h(".pl-refresh"), fold: h(".pl-causes-toggle") };
};

const sizes = [
  { name: "foldable 724x784 touch", width: 724, height: 784, touch: true },
  { name: "phone 380x800 touch", width: 380, height: 800, touch: true },
  { name: "desktop 1550x1000 mouse", width: 1550, height: 1000, touch: false },
];

describe.skipIf(!browser)("Plan page header in a real browser (BOS-1657)", () => {
  for (const s of sizes) {
    it(`${s.name}: chart starts in the top third on short screens; touch keeps Refresh 32 px and the fold bar 40 px`, async () => {
      const page = await browser!.newPage({ viewport: { width: s.width, height: s.height }, hasTouch: s.touch, isMobile: s.touch });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        await page.waitForSelector(".pl-causes-toggle", { timeout: 15_000 });
        const m = await page.evaluate(measure);
        // The foldable is the screen BOS-1525 was about; a 380 px phone wraps the hint onto more lines.
        if (s.width >= 700 && s.height <= 800) expect(m.chartTop).toBeLessThan(m.innerHeight / 3);
        if (s.touch) {
          expect(m.refresh).toBeGreaterThanOrEqual(32);
          expect(m.fold).toBeGreaterThanOrEqual(40);
        } else {
          expect(m.refresh).toBeGreaterThanOrEqual(28);
        }
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
