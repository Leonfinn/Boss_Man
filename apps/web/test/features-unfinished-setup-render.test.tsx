// @vitest-environment jsdom
// BOS-2521: the real Features page with 30 seeded features, a long title and all three setup tags on one row, and the
// switch on. Rendered to markup with the real styles.css and read in a headless browser at 1667, 1550 and 390 px: the
// toolbar switches row and the tags must not overlap, and nothing may run off the row. A real-browser check, not a
// CSS-text one. Skipped, not failed, where no browser is installed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Company, Driver, Feature, ScoredFeatures } from "../src/api";
import { Features } from "../src/pages/Features";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const driver: Driver = { id: "d1", name: "Reach", weight: 1 } as Driver;

const feature = (i: number, over: Record<string, unknown> = {}): Feature =>
  ({
    id: `f${i}`, companyId: "c1", areaId: null, parentId: null, title: `Feature number ${i}`, description: null, status: "planned",
    effort: 3, driverScores: { d1: 2 }, objectiveId: "o1", milestoneId: null, portalVisible: true, keepOffPortal: false,
    createdAt: "2026-10-19T09:00:00Z", demand: 2, value: 2.4, priority: 2.4, tickets: { total: 0, done: 0, items: [] },
    ...over,
  }) as unknown as Feature;

// 30 features, one with a long title and all three gaps at once, so its tags must fit the row at every width.
const rows: Feature[] = Array.from({ length: 30 }, (_, i) =>
  i === 0
    ? feature(0, {
        title: "A very long feature title that keeps going and going so the row has to wrap around the setup tags without pushing them off the edge of the visible row",
        effort: null,
        objectiveId: null,
        portalVisible: false,
      })
    : i === 1
      ? feature(1, { effort: null })
      : i === 2
        ? feature(2, { objectiveId: null })
        : i === 3
          ? feature(3, { portalVisible: false, keepOffPortal: false })
          : feature(i),
);
const payload: ScoredFeatures = { settings: { demandWeight: 1, ceoTriage: false }, drivers: [driver], maxDemand: 12, features: rows };

let html = "";
beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/features")) return new Response(JSON.stringify(payload), { status: 200 });
      if (url.includes("/feedback-settings")) return new Response(JSON.stringify({ drivers: [], areas: [] }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
  const { container, findByText } = (await import("@testing-library/react")).render(
    <Features companies={[company]} companyId="c1" featureId={undefined} go={() => {}} />,
  );
  // Wait for the list to actually draw (the poll resolves after mount), not a fixed sleep.
  await findByText("4 features need setup");
  html = container.innerHTML;
});

afterAll(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `features-unfinished-setup-${name}.png`) : null);

// Built inside each test, after beforeAll has captured the rendered markup.
const doc = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main { padding: 16px; }
</style></head><body><main>${html}</main></body></html>`;

/** The toolbar switch box and every setup tag's box, and whether anything crosses or leaves the row. */
const read = () => {
  // The toolbar's inner div is display:contents (no box), so measure the toolbar card and the switch label itself.
  const toolbar = document.querySelector("section.features-toolbar") as HTMLElement | null;
  const tb = toolbar?.getBoundingClientRect();
  const switchLabel = document.querySelector('label[title*="no place on the roadmap"]') as HTMLElement | null;
  const sl = switchLabel?.getBoundingClientRect();
  const tagAt = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const tags = [...document.querySelectorAll(".feature-setup .tag")].filter((t) => t.getBoundingClientRect().height > 0).map(tagAt);
  const longRow = [...document.querySelectorAll("tr")].find((tr) => tr.textContent?.includes("A very long feature title")) as HTMLElement | undefined;
  const longTags = longRow ? [...longRow.querySelectorAll(".feature-setup .tag")].map(tagAt) : [];
  const cell = longRow?.querySelector("td.feature-name") as HTMLElement | undefined;
  const cellBox = cell?.getBoundingClientRect();
  const inside = (outer: DOMRect | undefined, inner: DOMRect | undefined) => {
    if (!outer || !inner) return false;
    return inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
  };
  return {
    switchText: switchLabel?.textContent ?? "",
    switchShown: !!sl && sl.height > 0 && sl.width > 0,
    pageScroll: document.documentElement.scrollWidth - window.innerWidth,
    tagsShown: tags.length,
    longTags: longTags.length,
    // Each of the three tags on the long row sits inside its cell, left to right.
    longTagsInside: !!cellBox && longTags.every((t) => t.left >= cellBox.left - 0.5 && t.right <= cellBox.right + 0.5),
    // A wrap: the tags take more than one line inside the cell but never overlap one another.
    longTagsOverlap: longTags.some((a, i) => longTags.some((b, j) => i < j && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)),
    // The switch sits inside the toolbar card, and the toolbar inside the page.
    switchInside: inside(tb, sl) && !!tb && tb.left >= 0 && tb.right <= window.innerWidth + 1,
  };
};

const devices = [
  { name: "brave-1667", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("unfinished setup renders on the real page (BOS-2521)", () => {
  it("built the page with 30 features and the count", () => {
    expect(rows).toHaveLength(30);
    expect(html).toContain("Unfinished setup");
    expect(html).toContain("4 features need setup");
    expect(html).toContain("No size");
    expect(html).toContain("Not on the roadmap");
    expect(html).toContain("Portal not decided");
  });

  for (const d of devices) {
    it(`${d.name}: the switch row and the tags fit, without overlap or overflow`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(doc(), { waitUntil: "load" });
        const m = (await page.evaluate(read)) as ReturnType<typeof read>;
        expect(m.switchShown).toBe(true);
        expect(m.switchText).toContain("Unfinished setup");
        expect(m.switchText).toContain("4 features need setup");
        expect(m.tagsShown).toBe(6);
        expect(m.longTags).toBe(3);
        expect(m.longTagsInside).toBe(true);
        expect(m.longTagsOverlap).toBe(false);
        expect(m.switchInside).toBe(true);
        expect(m.pageScroll).toBeLessThanOrEqual(1);
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
