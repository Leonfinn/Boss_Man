import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite";

// A rendering check of the compact Board cards (BOS-1157), in headless Chromium: the real Board page
// (bundled from src) runs against a stubbed API with the real styles.css, so the title clamp, the
// arrow that shows only on cut text, and the open/close all come from the real code and real layout.
// jsdom does no layout, so board-compact-cards.test.tsx only covers the React wiring.
// Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  waitForSelector: (sel: string, opts?: { timeout?: number }) => Promise<unknown>;
  click: (sel: string) => Promise<void>;
  keyboard: { press: (key: string) => Promise<void> };
  focus: (sel: string) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
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
      lib: { entry: fileURLToPath(new URL("./fixtures/board-compact-entry.tsx", import.meta.url)), formats: ["iife"], name: "BoardCompact", fileName: "b" },
    },
  })) as unknown as { output: { type: string; code?: string }[] }[] | { output: { type: string; code?: string }[] };
  const outputs = Array.isArray(out) ? out.flatMap((o) => o.output) : out.output;
  return outputs.filter((o) => o.type === "chunk").map((o) => o.code).join("\n");
}

const js = browser ? await bundle() : "";
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>window.__errs=[];window.addEventListener("error",e=>window.__errs.push(String(e.message)));</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

const measure = () => {
  const card = (n: string) => {
    const a = [...document.querySelectorAll("article")].find((x) => x.textContent?.includes(`ACM-${n}`)) as HTMLElement;
    const title = a.querySelector("h3 a") as HTMLElement;
    const lineH = parseFloat(getComputedStyle(title).lineHeight) || parseFloat(getComputedStyle(title).fontSize) * 1.2;
    const arrow = a.querySelector("button.expand");
    return {
      cut: title.scrollHeight > title.clientHeight + 1,
      titleLines: Math.round(title.getBoundingClientRect().height / lineH),
      titleHeight: title.getBoundingClientRect().height,
      cardHeight: a.getBoundingClientRect().height,
      arrow: !!arrow,
      expanded: arrow?.getAttribute("aria-expanded") ?? null,
      overflowX: a.scrollWidth > a.clientWidth + 1,
    };
  };
  return { long: card("1"), short: card("2"), waits: card("3"), pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
};

const sizes = [
  { name: "desktop 1550", width: 1550, height: 1000, touch: false },
  { name: "wide 1667 touch", width: 1667, height: 724, touch: true },
  { name: "phone 380", width: 380, height: 800, touch: true },
];

describe.skipIf(!browser)("compact Board cards in a real browser (BOS-1157)", () => {
  for (const s of sizes) {
    it(`${s.name}: long title is cut at 2 lines, the arrow opens and closes it, a short card has no arrow`, async () => {
      const page = await browser!.newPage({ viewport: { width: s.width, height: s.height }, hasTouch: s.touch, isMobile: s.touch });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        await page.waitForSelector("article button.expand", { timeout: 15_000 }).catch(async (e) => {
          throw new Error(`${e}\n${await page.evaluate(() => JSON.stringify((window as unknown as { __errs: string[] }).__errs) + document.querySelector("article")?.outerHTML.slice(0, 900) + JSON.stringify(((a) => a && [a.scrollHeight, a.clientHeight, a.scrollWidth, a.clientWidth, getComputedStyle(a).display])(document.querySelector("h3 a") as HTMLElement)))}`);
        });
        const before = (await page.evaluate(measure)) as ReturnType<typeof measure>;
        expect(before.long.cut).toBe(true);
        expect(before.long.titleLines).toBeLessThanOrEqual(2);
        expect(before.long.arrow).toBe(true);
        expect(before.long.expanded).toBe("false");
        expect(before.short.cut).toBe(false);
        expect(before.short.arrow).toBe(false);
        expect(before.waits.arrow).toBe(true);
        expect(before.long.overflowX).toBe(false);

        const sel = 'article:has(h3 a[href$="long"]) button.expand';
        await page.click(sel);
        const open = (await page.evaluate(measure)) as ReturnType<typeof measure>;
        expect(open.long.expanded).toBe("true");
        expect(open.long.titleHeight).toBeGreaterThan(before.long.titleHeight);
        expect(open.long.titleLines).toBeGreaterThan(2);
        expect(open.long.cardHeight).toBeGreaterThan(before.long.cardHeight);
        expect(open.long.overflowX).toBe(false);

        await page.click(sel);
        const closed = (await page.evaluate(measure)) as ReturnType<typeof measure>;
        expect(closed.long.expanded).toBe("false");
        expect(closed.long.titleLines).toBeLessThanOrEqual(2);
        expect(closed.long.cardHeight).toBeCloseTo(before.long.cardHeight, 0);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  it("the arrow opens a card from the keyboard (Enter)", async () => {
    const page = await browser!.newPage({ viewport: { width: 1550, height: 1000 } });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      await page.waitForSelector("article button.expand", { timeout: 15_000 });
      const sel = 'article:has(h3 a[href$="long"]) button.expand';
      await page.focus(sel);
      await page.keyboard.press("Enter");
      const open = (await page.evaluate(measure)) as ReturnType<typeof measure>;
      expect(open.long.expanded).toBe("true");
    } finally {
      await page.close();
    }
  }, 60_000);
});
