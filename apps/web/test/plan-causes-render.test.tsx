// @vitest-environment node
//
// A real browser, not jsdom: the box's own markup is rendered here (React's server renderer, so no
// DOM is needed), then that markup is loaded into headless Chromium and measured at real widths.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { afterAll, describe, expect, it } from "vitest";
import type { Plan as PlanData, PlanNode } from "../src/api";
import { Causes } from "../src/pages/Plan";

// BOS-745: a rendering check of the "What's holding work up" box at real widths, not a reading of
// the CSS text. The box's own markup is rendered by the real component (the same tree the pages
// show), then that markup is loaded into a real Chromium at a desktop width, the owner's phone
// width (380px), the recorded unfolded-foldable profile, and the owner's recorded Brave touch
// profile, and the box is measured there.
// Skipped, not failed, where no browser is installed; the jsdom test in plan-causes-fold.test.tsx
// still checks the behaviour everywhere.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
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
const ticket = (i: number, holdingUp: number): PlanNode => ({
  id: `t${i}`,
  kind: "ticket",
  ref: `BOS-${100 + i}`,
  title: `A long blocker title that will wrap on a narrow phone screen number ${i}`,
  state: "in_progress",
  open: true,
  link: `#/ticket/t${i}`,
  assignee: "Someone With A Long Name",
  project: "Development",
  layer: 0,
  blocked: false,
  causes: [],
  holdingUp,
});

const manyBlockers = (n: number): PlanData => {
  const waiting: PlanNode = {
    id: "waiting",
    kind: "ticket",
    ref: "BOS-900",
    title: "Waiting task",
    state: "blocked",
    open: true,
    link: "#/ticket/waiting",
    assignee: "Someone",
    project: "Development",
    layer: 1,
    blocked: true,
    causes: Array.from({ length: n }, (_, i) => `t${i}`),
    holdingUp: 0,
  };
  return {
    nodes: [...Array.from({ length: n }, (_, i) => ticket(i, n - i)), waiting],
    edges: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, from: `t${i}`, to: "waiting" })),
    columns: [Array.from({ length: n }, (_, i) => `t${i}`), ["waiting"]],
  };
};

// The box's real markup, from the real component the page uses, in the state the browser would show
// after a reload with that choice made (the component reads the choice from localStorage on mount,
// so a small stand-in for it here renders the same markup). The markup is then loaded into a real
// Chromium below and measured; the folded/unfolded margins are measured, not the CSS text.
function causesHtml(plan: PlanData, choice: { showAll?: boolean; rolled?: boolean } = {}): string {
  const saved = globalThis.localStorage;
  const map = new Map<string, string>();
  if (choice.showAll) map.set("bossman.plan.causesOpen", "1");
  if (choice.rolled) map.set("bossman.plan.causesRolledUp", "1");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) },
  });
  try {
    const box = renderToString(createElement(Causes, { plan }));
    if (!box.includes('id="causes-h"')) throw new Error("the causes box did not render");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0">${box}</body></html>`;
  } finally {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved });
  }
}

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  { name: "phone 380px", viewport: { width: 380, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: "foldable unfolded", viewport: { width: 840, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 },
  // The owner's recorded Brave touch profile (1667x1668 CSS px, ratio 3), from the devices tool.
  { name: "owner Brave touch 1667px", viewport: { width: 1667, height: 1668 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

describe.skipIf(!browser)("What's holding work up at real widths (BOS-745)", () => {
  for (const v of VIEWPORTS) {
    it(`${v.name}: 5 items show, the 'Show all 14' button and heading arrow are reachable, and expanding fits`, async () => {
      const page = await browser!.newPage({ viewport: v.viewport, deviceScaleFactor: v.deviceScaleFactor, hasTouch: v.hasTouch, isMobile: v.isMobile });
      try {
        // Collapsed: 5 items, a reachable "Show all 14" and heading arrow, no sideways overflow.
        await page.setContent(causesHtml(manyBlockers(14)), { waitUntil: "load" });
        const m = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll("#causes-list > li"));
          const more = document.querySelector(".pl-causes-more") as HTMLElement;
          const toggle = document.querySelector(".pl-causes-toggle") as HTMLElement;
          const box = document.querySelector("#causes-body") as HTMLElement;
          const r = more.getBoundingClientRect();
          const t = toggle.getBoundingClientRect();
          return {
            items: items.length,
            label: more.textContent?.trim(),
            moreExpanded: more.getAttribute("aria-expanded"),
            moreInView: r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0,
            toggleInView: t.left >= 0 && t.right <= window.innerWidth + 1 && t.height >= 32,
            moreWidth: r.width,
            firstIsBiggest: items[0]?.textContent?.includes("holds up 14") ?? false,
            boxScroll: box.scrollWidth <= box.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1,
          };
        });
        expect(m.items).toBe(5);
        expect(m.label).toContain("Show all 14");
        expect(m.moreExpanded).toBe("false");
        expect(m.moreInView).toBe(true);
        expect(m.toggleInView).toBe(true);
        // The button has real tappable width, not a text-squeezed sliver.
        expect(m.moreWidth).toBeGreaterThanOrEqual(80);
        // Kept most-held-up first.
        expect(m.firstIsBiggest).toBe(true);
        // No sideways overflow of the page at this width.
        expect(m.boxScroll).toBe(true);

        // Expanded (the box re-reads the saved choice on load): every item shows and it still fits.
        await page.setContent(causesHtml(manyBlockers(14), { showAll: true }), { waitUntil: "load" });
        const after = await page.evaluate(() => ({
          items: document.querySelectorAll("#causes-list > li").length,
          label: (document.querySelector(".pl-causes-more") as HTMLElement).textContent?.trim(),
          expanded: (document.querySelector(".pl-causes-more") as HTMLElement).getAttribute("aria-expanded"),
          fits: document.documentElement.scrollWidth <= window.innerWidth + 1,
        }));
        expect(after.items).toBe(14);
        expect(after.label).toContain("Show fewer");
        expect(after.expanded).toBe("true");
        expect(after.fits).toBe(true);

        // Rolled up (the saved heading choice): the body is out of the flow, the arrow points right,
        // and the box is no taller than its heading.
        await page.setContent(causesHtml(manyBlockers(14), { rolled: true }), { waitUntil: "load" });
        const rolled = await page.evaluate(() => {
          const body = document.querySelector("#causes-body") as HTMLElement;
          const toggle = document.querySelector(".pl-causes-toggle") as HTMLElement;
          const card = document.querySelector(".card") as HTMLElement;
          return {
            hidden: body.hidden || getComputedStyle(body).display === "none" || body.offsetHeight === 0,
            expanded: toggle.getAttribute("aria-expanded"),
            arrow: (document.querySelector(".pl-causes-toggle .pl-arrow") as HTMLElement).textContent?.trim(),
            label: (document.querySelector(".pl-causes-action") as HTMLElement).textContent?.trim(),
            cardH: card.getBoundingClientRect().height,
            headH: toggle.getBoundingClientRect().height,
          };
        });
        expect(rolled.hidden).toBe(true);
        expect(rolled.expanded).toBe("false");
        expect(rolled.arrow).toBe("▾");
        expect(rolled.label).toContain("Show");
        // Folded is one slim line: no panel padding beyond the 1px borders.
        expect(rolled.cardH).toBeLessThanOrEqual(rolled.headH + 4);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
