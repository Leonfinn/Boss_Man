// @vitest-environment node
// BOS-1896: Funding → Budgets → Spending limit. At the owner's Brave profile (1667 wide) the label
// "Spending limit per month (USD)" touched its input with no gap. This renders the real page in
// Chromium at the recorded profile and measures the space between the label and its input.
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

const brave = (JSON.parse(readFileSync(new URL("./device-profiles/owner-brave-foldable.json", import.meta.url), "utf8")) as {
  readings: Array<{ width: number; height: number; pixelRatio: number; coarsePointer: boolean; units: { vh: number } }>;
}).readings[0]!;
const now = new Date().toISOString();

const api: Record<string, unknown> = {
  ...API,
  "/api/funding-sources": [],
  "/api/budgets": [],
  "/api/projects/p1/spend": {
    tokens: { month: { input: 1_200_000, output: 340_000 }, total: { input: 8_000_000, output: 2_100_000 } },
    monthMicros: 4_200_000,
    totalMicros: 31_000_000,
    ticketCostCapMicros: 5_000_000,
    monthlyCapMicros: 50_000_000,
    monthStart: now,
    plan: [],
    topTickets: [],
  },
};

const browser = await launch();
const vite = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

describe.skipIf(!browser || !vite)("Spending limit row (BOS-1896)", () => {
  it("keeps a gap between the label and its input at the owner's 1667 px profile", async () => {
    const page = await browser!.newPage({
      viewport: { width: brave.width, height: brave.units.vh },
      deviceScaleFactor: brave.pixelRatio,
      hasTouch: brave.coarsePointer,
    });
    try {
      await stubApi(page, api);
      await page.goto(`${vite!.resolvedUrls.local[0]}#settings/c1/funding`, { waitUntil: "networkidle" });
      await page.waitForSelector("text=Costliest tasks", { timeout: 15_000 });

      const label = page.locator('label[for^="limit-usd-"]').first();
      const input = page.getByLabel("Spending limit per month (USD)").first();
      await input.scrollIntoViewIfNeeded();

      const l = await label.boundingBox();
      const i = await input.boundingBox();
      expect(l && i, "the label and its input are both drawn").toBeTruthy();

      // The label sits above its input with the field's 6px gap; the old inline label left none at all.
      const gap = i!.y - (l!.y + l!.height);
      expect(gap, "label-to-input gap").toBeGreaterThanOrEqual(4);
      expect(gap, "label-to-input gap").toBeLessThanOrEqual(12);
    } finally {
      await page.close();
    }
  }, 60_000);
});
