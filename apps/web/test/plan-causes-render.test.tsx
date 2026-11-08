// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Plan as PlanData, PlanNode } from "../src/api";
import { Plan } from "../src/pages/Plan";

// BOS-745: a rendering check of the "What's holding work up" box at real widths, not a reading of
// the CSS text. The box's own markup is rendered by the real component (the same tree the pages
// show), then that markup is loaded into a real Chromium at a desktop width, the owner's phone
// width (380px) and the recorded unfolded-foldable profile, and the box is measured there.
//
// Skipped, not failed, where no browser is installed; the jsdom test in plan-causes-fold.test.tsx
// still checks the behaviour everywhere.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
  click: (selector: string) => Promise<void>;
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company = { id: "c1", name: "App Co", mission: "x", paused: false, agents: [] } as Company;

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

// The box's real markup, from the real component, wrapped in the page it sits on.
async function causesHtml(plan: PlanData): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(plan), { status: 200, headers: { "content-type": "application/json" } })),
  );
  const { container } = render(<Plan companies={[company]} companyId="c1" go={() => {}} />);
  // Wait for the async plan fetch to land and the box to appear.
  for (let i = 0; i < 100 && !container.querySelector("#causes-h"); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const card = container.querySelector(".card") as HTMLElement | null;
  if (!card) throw new Error("the causes box did not render");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0">${card.outerHTML}</body></html>`;
}

const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  { name: "phone 380px", viewport: { width: 380, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: "foldable unfolded", viewport: { width: 840, height: 900 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 },
];

describe.skipIf(!browser)("What's holding work up at real widths (BOS-745)", () => {
  for (const v of VIEWPORTS) {
    it(`${v.name}: 5 items show, the 'Show all 14' button and heading arrow are reachable, and expanding shows all`, async () => {
      const html = await causesHtml(manyBlockers(14));
      const page = await browser!.newPage({ viewport: v.viewport, deviceScaleFactor: v.deviceScaleFactor, hasTouch: v.hasTouch, isMobile: v.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
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
            moreInView: r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0,
            toggleInView: t.left >= 0 && t.right <= window.innerWidth + 1 && t.height >= 32,
            moreWidth: r.width,
            boxScroll: box.scrollWidth <= box.clientWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1,
          };
        });
        expect(m.items).toBe(5);
        expect(m.label).toContain("Show all 14");
        expect(m.moreInView).toBe(true);
        expect(m.toggleInView).toBe(true);
        // The button has real tappable width on a touch screen, not a text-squeezed sliver.
        expect(m.moreWidth).toBeGreaterThanOrEqual(80);
        // No sideways overflow of the page at this width.
        expect(m.boxScroll).toBe(true);

        // Expand: every item shows and the page still fits the width.
        await page.click(".pl-causes-more");
        const after = await page.evaluate(() => ({
          items: document.querySelectorAll("#causes-list > li").length,
          label: (document.querySelector(".pl-causes-more") as HTMLElement).textContent?.trim(),
          fits: document.documentElement.scrollWidth <= window.innerWidth + 1,
        }));
        expect(after.items).toBe(14);
        expect(after.label).toContain("Show fewer");
        expect(after.fits).toBe(true);

        // The heading arrow rolls the whole box up and the body is gone from the flow.
        await page.click(".pl-causes-toggle");
        const rolled = await page.evaluate(() => ({
          hidden: (document.querySelector("#causes-body") as HTMLElement).hidden,
          expanded: (document.querySelector(".pl-causes-toggle") as HTMLElement).getAttribute("aria-expanded"),
        }));
        expect(rolled.hidden).toBe(true);
        expect(rolled.expanded).toBe("false");
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
