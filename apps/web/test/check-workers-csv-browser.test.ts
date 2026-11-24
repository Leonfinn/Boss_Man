import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// BOS-2519: Settings → Check workers has two "Download CSV" buttons (the machines' 7 days, the check line's 7 days).
// This mounts the real page in Chromium with made-up machines, presses each button, reads the file the browser saved,
// and checks the buttons fit the screen at the owner's sizes. With BOSSMAN_SCRATCH set it saves screenshots.
// Skipped, not failed, where no browser or Vite is installed.

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const worker = { id: "w1", name: "Spare machine", enabled: true, connected: false, slots: 2, reportedSlots: 2, limit: 2, checkThreads: null, checkMemoryMb: null, imageCommit: null, toolchain: null, lastSeenAt: null, companies: [], reason: null };
const stat = (machine: string, extra: object = {}) => ({ machine, total: 12, passed: 10, failed: 1, stuck: 1, medianSeconds: 840, longestSeconds: 3000, recent: [], ...extra });
const api = {
  ...API,
  "/api/settings/check-queue": { mode: "server", slots: 2, maxSlots: 4, defaultSlots: 2, runnersTooOld: [], workers: [worker] },
  "/api/settings/check-workers/stats": [stat("runner"), stat("w1", { total: 0, passed: 0, failed: 0, stuck: 0, medianSeconds: null, longestSeconds: null })],
  "/api/settings/check-workers/line": {
    days: [
      { date: "2026-11-22", quick: 0, full: 0, merge: 0 },
      { date: "2026-11-23", quick: 4, full: 1, merge: 2 },
    ],
    kinds: [
      { kind: "quick", total: 4, cancelled: 1, medianWaitSeconds: 1200, longestWaitSeconds: 7200, medianRunSeconds: 300 },
      { kind: "full", total: 1, cancelled: 0, medianWaitSeconds: null, longestWaitSeconds: null, medianRunSeconds: null },
      { kind: "merge", total: 2, cancelled: 0, medianWaitSeconds: 3600, longestWaitSeconds: 5400, medianRunSeconds: 2400 },
    ],
    busiestHours: [],
    waitingNow: 0,
    oldestWaitSeconds: null,
    timeZone: "UTC",
  },
  "/api/run-limits": { instance: 4, company: 2, background: 1, defaults: { instance: 4, company: 2, background: 1 } },
  "/api/wip-limits": { agent: 2, company: null, defaultAgent: 2 },
  "/api/host-facts": { hostName: null, reportedAt: null, ownerFacts: [], facts: {} },
};

const PROFILES = [
  { name: "phone-380", width: 380, height: 800, touch: true, ratio: 2 },
  { name: "brave-1667", width: 1667, height: 724, touch: true, ratio: 1 },
  { name: "safari-1550", width: 1550, height: 1000, touch: false, ratio: 1 },
];

describe.skipIf(!can)("Settings → Check workers: Download CSV (BOS-2519, real page)", () => {
  for (const p of PROFILES) {
    it(`${p.name}: both buttons save their file and fit the screen`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#settings/c1/limits`, { waitUntil: "networkidle" });
        await page.waitForSelector("[data-testid=check-workers]", { timeout: 15_000 }).catch(async (e: Error) => {
          throw new Error(`${e.message}; body: ${(await page.innerText("body")).slice(0, 400)}`);
        });
        const root = page.locator("[data-testid=check-workers]");
        await root.locator("summary", { hasText: "Check line, last 7 days" }).click();
        const buttons = root.getByRole("button", { name: "Download CSV" });
        await buttons.first().waitFor();
        expect(await buttons.count()).toBe(2);
        // Each button is fully inside the window and tall enough to tap on a phone. (The page's own width on a phone is
        // wider than the window because the existing check-line table does not shrink; that is BOS-2436's, not checked here.)
        for (let i = 0; i < 2; i++) {
          const box = await buttons.nth(i).boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(p.width);
          if (p.touch && p.width < 641) expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        if (out) {
          mkdirSync(out, { recursive: true });
          await root.screenshot({ path: path.join(out, `check-workers-csv-${p.name}.png`) });
        }
        const text = async (i: number) => {
          const [dl] = await Promise.all([page.waitForEvent("download"), buttons.nth(i).click()]);
          return { name: dl.suggestedFilename() as string, body: readFileSync(await dl.path(), "utf8") };
        };
        // The line's button comes first on the page (the fold is above the machines), the machines' button second.
        const first = await text(0);
        const second = await text(1);
        const line = first.name.startsWith("check-line") ? first : second;
        const machines = first.name.startsWith("check-line") ? second : first;
        expect(line.name).toMatch(/^check-line-7-days-\d{4}-\d{2}-\d{2}\.csv$/);
        expect(line.body.split("\r\n")).toEqual([
          "date,quick,full,merge,total",
          "2026-11-22,0,0,0,0",
          "2026-11-23,4,1,2,7",
          "",
          "kind,checks,cancelled,median_wait_seconds,longest_wait_seconds,median_run_seconds",
          "quick,4,1,1200,7200,300",
          "full,1,0,,,",
          "merge,2,0,3600,5400,2400",
          "",
        ]);
        expect(machines.name).toMatch(/^check-workers-7-days-\d{4}-\d{2}-\d{2}\.csv$/);
        expect(machines.body.split("\r\n")).toEqual([
          "machine,connected,checks,passed,failed,stuck,median_seconds,longest_seconds",
          "Company runner,yes,12,10,1,1,840,3000",
          "Spare machine,no,0,0,0,0,,",
          "",
        ]);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
