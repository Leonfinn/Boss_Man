import { readFileSync } from "node:fs";
import { DEFAULT_WATCHDOG } from "@boss-man/shared";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// BOS-2541: Settings → Watchdog → "Test the rules": "Download CSV" sits beside "Hide ones that cleared by themselves",
// saves a real watchdog-test-<days>d-<date>.csv of the rows in the table, and the row fits at the owner's sizes.
// Made-up fixtures through Vite (real-page.ts). Skipped, not failed, where no browser is installed.

const browser = await launch();
const server = browser ? await startVite() : null;
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const LONG = "A very long ticket title that goes on and on without any break, so the row has to cope with it ".repeat(2);
const flag = (n: number, over: Record<string, unknown> = {}) => ({ ticketId: `t${n}`, ref: `BOS-${n}`, title: `Ticket ${n}`, rule: "unassigned", firstAt: "2026-11-23T12:00:00.000Z", handOffs: 1, verdict: "still open", ...over });
const api = {
  ...API,
  "/api/companies/c1/watchdog": { settings: { ...DEFAULT_WATCHDOG, enabled: true }, scrumMaster: null, lastSweepAt: null, trippedAt: null, trippedReason: null, openFlags: 0 },
  "/api/companies/c1/watchdog/backtest": {
    from: "2026-11-22T00:00:00Z", to: "2026-11-24T00:00:00Z", scrumMasterWakes: 1, busiestHourWakes: 1, wouldTripCap: false, caveats: [],
    flags: [flag(1, { title: LONG }), flag(2, { verdict: "cleared within 30 min" }), flag(3, { rule: "stale_in_progress" })],
  },
};

const SIZES = [
  { name: "1667", width: 1667, height: 724, touch: true },
  { name: "1550", width: 1550, height: 900, touch: false },
  { name: "390", width: 390, height: 844, touch: true },
];

describe.skipIf(!browser || !server)("BOS-2541 Watchdog test result Download CSV in a real browser", () => {
  for (const s of SIZES) {
    it(`${s.name}: the button saves the rows shown and the row fits`, async () => {
      const page = await browser!.newPage({ viewport: { width: s.width, height: s.height }, hasTouch: s.touch, isMobile: s.touch });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#settings/c1/watchdog`, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Run the test", exact: true }).click();
        const csvButton = page.getByRole("button", { name: "Download CSV", exact: true });
        await csvButton.waitFor({ timeout: 15_000 });
        const b = await csvButton.boundingBox();
        const l = await page.getByText("Hide ones that cleared by themselves").boundingBox();
        expect(b && l).toBeTruthy();
        // The button itself stays on screen (the results table below may scroll sideways on a phone; that is not this change).
        expect(b!.x + b!.width, JSON.stringify(b)).toBeLessThanOrEqual(s.width);
        const apart = b!.x >= l!.x + l!.width - 0.5 || b!.y >= l!.y + l!.height - 0.5;
        expect(apart, JSON.stringify({ b, l })).toBe(true);
        const dir = process.env.BOSSMAN_SCRATCH;
        if (dir) await page.screenshot({ path: `${dir}/watchdog-csv-${s.name}.png`, fullPage: true });
        const [file] = await Promise.all([page.waitForEvent("download"), csvButton.press("Enter")]);
        expect(file.suggestedFilename()).toMatch(/^watchdog-test-2d-\d{4}-\d{2}-\d{2}\.csv$/);
        const text = readFileSync(await file.path(), "utf8");
        expect(text.trim().split("\r\n")).toHaveLength(4);
        expect(text).toContain("A very long ticket title");
        expect(text).toContain("no movement in progress");
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
