import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { DbHistory, DiskHistory } from "../src/pages/settings/System";

// A rendering check of the Server health box's disk line (BOS-2918): the 14-day disk table sits next to the
// database table, shows the 7-day rate line, and neither runs off the page at the owner's two devices and a phone.
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `disk-history-${name}.png`) : null);

const GB = 1024 ** 3;
const days = Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
const dbHistory = days.map((day, i) => ({ day, bytes: (2 + i * 0.05) * GB }));
const diskHistory = days.map((day, i) => ({ day, usedBytes: (117 + i * 9) * GB, totalBytes: 500 * GB }));
const trend = { perDayBytes: 9 * GB, growthPercent7d: 12.6, daysToFull: 25 };

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(
  // The same card and list the Server health box renders (Section in settings/shared.tsx, ServerHealth in System.tsx).
  <section className="card" data-testid="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
    <h2 style={{ fontSize: 17, fontWeight: 600 }}>Server health</h2>
    <ul style={{ fontSize: 14, margin: 0, paddingLeft: 18, minWidth: 0 }}>
      <li>
        Data disk
        <DiskHistory history={diskHistory} trend={trend} />
      </li>
      <li>
        Database
        <DbHistory history={dbHistory} />
      </li>
    </ul>
  </section>,
)}</main></body></html>`;

const read = () => {
  document.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));
  const db = document.querySelector('[data-testid="health-db-history"]') as HTMLElement;
  const disk = document.querySelector('[data-testid="health-disk-history"]') as HTMLElement;
  const dbBox = db.getBoundingClientRect();
  const diskBox = disk.getBoundingClientRect();
  return {
    diskText: disk.innerText,
    trendText: (disk.querySelector('[data-testid="health-disk-trend"]') as HTMLElement).innerText,
    rows: disk.querySelectorAll("tr").length,
    diskBelowDb: dbBox.top >= diskBox.bottom - 0.5,
    diskRight: diskBox.right,
    dbRight: dbBox.right,
    cardRight: (document.querySelector('[data-testid="card"]') as HTMLElement).getBoundingClientRect().right,
    tableRights: [...document.querySelectorAll("details table")].map((t) => t.getBoundingClientRect().right),
    wrapScrolls: [...document.querySelectorAll("details table")].every((t) => getComputedStyle(t.parentElement as HTMLElement).overflowX === "auto"),
    pageWidth: document.documentElement.clientWidth,
    scrollOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("server health disk line in a real browser (BOS-2918)", () => {
  for (const d of devices) {
    it(`${d.name}: the 14-day disk and database tables sit one above the other and fit inside the card`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got.diskText).toContain("Disk used, last 14 days");
        expect(got.trendText).toContain("full in about 25 days");
        expect(got.rows).toBe(14);
        expect(got.diskBelowDb).toBe(true);
        expect(got.diskRight).toBeLessThanOrEqual(got.cardRight + 0.5);
        expect(got.dbRight).toBeLessThanOrEqual(got.cardRight + 0.5);
        expect(got.cardRight).toBeLessThanOrEqual(got.pageWidth + 0.5);
        expect(got.wrapScrolls).toBe(true);
        expect(got.scrollOverflow).toBeLessThanOrEqual(1);
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
