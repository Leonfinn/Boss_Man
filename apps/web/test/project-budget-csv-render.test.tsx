import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// BOS-2543: the project spend page (Settings → Funding → Budgets) has a "Download CSV" button by "Costliest
// tasks", shown only when the list has rows. This mounts the real page in Chromium with made-up tasks, presses
// the button, reads the file the browser saved, and checks the button and heading fit the owner's sizes without
// overlapping. With BOSSMAN_SCRATCH set it saves screenshots. Skipped, not failed, where no browser or Vite is
// installed.

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const LONG = "A really long task title that wraps onto two lines in the list, with a comma, and more words to push it past the column";
const topTickets = [
  { id: "11111111-1111-4111-8111-111111111111", title: "Add the CSV export", micros: 12_345_678, planMicros: 4_000_000 },
  { id: "22222222-2222-4222-8222-222222222222", title: LONG, micros: 999_999, planMicros: 0 },
  { id: "33333333-3333-4333-8333-333333333333", title: "=Formula start", micros: 5_000, planMicros: 2_500 },
];
const spend = (rows: typeof topTickets) => ({ monthMicros: 30_000_000, totalMicros: 90_000_000, ticketCostCapMicros: null, monthlyCapMicros: null, monthStart: "2026-11-01T00:00:00.000Z", plan: [], topTickets: rows });

const PROFILES = [
  { name: "phone-390", width: 390, height: 800, touch: true, ratio: 2 },
  { name: "brave-1667", width: 1667, height: 724, touch: true, ratio: 1 },
  { name: "safari-1550", width: 1550, height: 1000, touch: false, ratio: 1 },
];

async function open(page: import("./real-page").Page): Promise<void> {
  await page.goto(`${server!.resolvedUrls.local[0]}#settings/c1/funding`, { waitUntil: "networkidle" });
  await page.waitForSelector("#budgets-h", { timeout: 15_000 }).catch(async (e: Error) => {
    throw new Error(`${e.message}; body: ${(await page.innerText("body")).slice(0, 400)}`);
  });
}

describe.skipIf(!can)("Project spend: Costliest tasks Download CSV (BOS-2543, real page)", () => {
  for (const p of PROFILES) {
    it(`${p.name}: the button fits beside the heading and saves the list as CSV`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        await stubApi(page, { ...API, "/api/projects/p1/spend": spend(topTickets) });
        await open(page);
        const funds = page.locator("#budgets-h").locator("..").locator("..");
        const heading = page.getByRole("heading", { name: "Costliest tasks" });
        const button = funds.getByRole("button", { name: "Download CSV" });
        await button.waitFor();
        const h = await heading.boundingBox();
        const b = await button.boundingBox();
        expect(h).not.toBeNull();
        expect(b).not.toBeNull();
        // The button sits inside the window, tall enough to tap on a phone, and never over the heading.
        expect(b!.x).toBeGreaterThanOrEqual(0);
        expect(b!.x + b!.width).toBeLessThanOrEqual(p.width);
        if (p.touch && p.width < 641) expect(b!.height).toBeGreaterThanOrEqual(44);
        const apart = b!.x + b!.width <= h!.x || h!.x + h!.width <= b!.x || b!.y + b!.height <= h!.y || h!.y + h!.height <= b!.y;
        expect(apart, `button at ${JSON.stringify(b)} overlaps heading ${JSON.stringify(h)}`).toBe(true);
        if (out) {
          mkdirSync(out, { recursive: true });
          await page.screenshot({ path: path.join(out, `project-budget-csv-${p.name}.png`), fullPage: true });
        }
        // Only take the download once, on the first profile, so the run is quick.
        if (p === PROFILES[0]) {
          const [dl] = await Promise.all([page.waitForEvent("download"), button.click()]);
          expect(dl.suggestedFilename()).toMatch(/^development-costliest-tasks-\d{4}-\d{2}-\d{2}\.csv$/);
          expect(readFileSync(await dl.path(), "utf8").split("\r\n")).toEqual([
            "rank,task,ticket_id,pay_as_you_go_usd,subscriptions_at_list_usd,both_together_usd",
            "1,Add the CSV export,11111111-1111-4111-8111-111111111111,12.35,4.00,16.35",
            `2,"${LONG}",22222222-2222-4222-8222-222222222222,1.00,0.00,1.00`,
            "3,'=Formula start,33333333-3333-4333-8333-333333333333,0.01,0.00,0.01",
            "",
          ]);
        }
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  it("shows no button when the list is empty", async () => {
    const page = await browser!.newPage({ viewport: { width: 1550, height: 1000 } });
    try {
      await stubApi(page, { ...API, "/api/projects/p1/spend": spend([]) });
      await open(page);
      await page.getByText("No spend or priced plan runs on this project's tasks yet.").waitFor();
      await page.getByRole("heading", { name: "Costliest tasks" }).waitFor();
      const funds = page.locator("#budgets-h").locator("..").locator("..");
      expect(await funds.getByRole("button", { name: "Download CSV" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});
