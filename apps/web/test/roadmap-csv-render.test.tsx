// @vitest-environment node
// BOS-2517: the Roadmap and Timeline tabs each have a "Download CSV". This renders the real page in Chromium,
// clicks the button and reads the file the browser saved. Skipped, not failed, where no browser is installed.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

const feature = (id: string, title: string, column: string, extra: object = {}) => ({
  id, title, status: "planned", rank: null, horizon: null, column, priority: 1, releasedAt: null, objective: null,
  publicSummary: null, showPublicly: false, tickets: { total: 4, done: 1 }, milestones: [], ...extra,
});
const forecast = (extra: object = {}) => ({ pointsDone: 5, pointsLeft: 8, unsized: 0, pace: 4, expectedFinish: "2026-12-10", daysLate: 0, ...extra });
const ms = (id: string, title: string, status: string, targetDate: string | null, f: object = {}) => ({
  id, title, targetDate, total: 8, done: 3, blocked: 0, active: 1, status, horizon: "now", pinned: null, forecast: forecast(f),
});
const api: Record<string, unknown> = {
  ...API,
  "/api/roadmap": [
    { id: "c1", name: "App Co", objectives: [{ id: "o1", title: "Launch", priority: 1, status: "active", keyResults: [], milestones: [ms("m1", "Beta", "late", "2026-11-01", { daysLate: 9 }), ms("m2", "GA", "on_track", "2027-01-15")] }] },
  ],
  "/api/roadmap/features": [
    { id: "c1", name: "App Co", features: [feature("f1", "Dark mode", "now", { rank: 1, objective: { id: "o1", title: "Launch", priority: 1 }, milestones: [{ id: "m1", title: "Beta", targetDate: "2026-11-01", pinned: null }] }), feature("f2", "Sign-in", "released", { releasedAt: "2026-10-02T00:00:00Z" })] },
  ],
};

const browser = await launch();
const vite = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

async function saved(hash: string, wait: string): Promise<{ name: string; text: string }> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await stubApi(page, api);
    await page.goto(`${vite!.resolvedUrls.local[0]}${hash}`, { waitUntil: "networkidle" });
    await page.waitForSelector(wait, { timeout: 15_000 });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), page.getByRole("button", { name: "Download CSV" }).click()]);
    return { name: dl.suggestedFilename(), text: readFileSync(await dl.path(), "utf8") };
  } finally {
    await page.close();
  }
}

describe.skipIf(!browser || !vite)("Roadmap Download CSV (BOS-2517)", () => {
  it("saves the features file from the Roadmap tab", async () => {
    const f = await saved("#roadmap/features", "text=Dark mode");
    expect(f.name).toMatch(/^roadmap-features-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = f.text.trim().split("\r\n");
    expect(lines[0]).toBe("company,column,rank,feature,status,objective,milestones,tasks_done,tasks_total,released,on_portal");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("App Co,Now,1,Dark mode,");
    expect(lines[1]).toContain("Beta (2026-11-01)");
    expect(lines[2]).toContain("App Co,Released,,Sign-in,");
  }, 60_000);

  it("saves the milestones file from the Timeline tab", async () => {
    const f = await saved("#roadmap/timeline", "text=Beta");
    expect(f.name).toMatch(/^roadmap-milestones-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = f.text.trim().split("\r\n");
    expect(lines[0]).toBe("company,objective,milestone,target_date,status,tasks_done,tasks_total,points_left,expected_finish,days_late");
    expect(lines[1]).toBe("App Co,Launch,Beta,2026-11-01,Late,3,8,8,2026-12-10,9");
    expect(lines).toHaveLength(3);
  }, 60_000);
});

// 30 features with one very long title, so the page is crowded; the new button must sit inside the page, clear of the tabs.
const LONG = "A very long feature title that keeps going and going so the card has to wrap it over several lines on a phone";
const crowd = {
  ...api,
  "/api/roadmap/features": [
    { id: "c1", name: "App Co", features: Array.from({ length: 30 }, (_, i) => feature(`f${i}`, i === 0 ? LONG : `Feature ${i}`, (["now", "next", "later"] as const)[i % 3]!, { rank: i + 1 })) },
  ],
};

describe.skipIf(!browser || !vite)("Roadmap Download CSV layout (BOS-2517)", () => {
  for (const width of [1667, 1550, 390]) {
    for (const tab of ["features", "timeline"]) {
      it(`${tab} tab at ${width} px: the button is on screen, inside the page and clear of the tabs`, async () => {
        const page = await browser!.newPage({ viewport: { width, height: 900 } });
        try {
          await stubApi(page, crowd);
          await page.goto(`${vite!.resolvedUrls.local[0]}#roadmap/${tab}`, { waitUntil: "networkidle" });
          await page.waitForSelector(tab === "features" ? `text=${LONG.slice(0, 20)}` : ".rm-obj", { timeout: 15_000 });
          const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
          const btn = await page.getByRole("button", { name: "Download CSV" }).boundingBox();
          const tabs = await box(".tabs");
          expect(btn, "the button is drawn").toBeTruthy();
          expect(btn!.x).toBeGreaterThanOrEqual(0);
          expect(btn!.x + btn!.width, "right edge inside the viewport").toBeLessThanOrEqual(width);
          expect(btn!.y + btn!.height, "above the tabs").toBeLessThanOrEqual(tabs.y + 1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll").toBe(true);
          const scratch = process.env.BOSSMAN_SCRATCH;
          if (scratch) await page.screenshot({ path: `${scratch}/roadmap-csv-${tab}-${width}.png` });
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }
});
