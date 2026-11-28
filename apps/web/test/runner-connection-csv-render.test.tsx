import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { connectionToCsv } from "../src/pages/settings/Runner";
import { API, launch, startVite, stubApi } from "./real-page";

// BOS-2545: Settings → Runner, "Connection, last 7 days" has a "Download CSV" under the gaps table. This mounts the
// real page in Chromium with made-up gaps, opens the fold, presses the button, reads the file the browser saved and
// checks the button fits the screen at the owner's sizes. With BOSSMAN_SCRATCH set it saves screenshots.
// Skipped, not failed, where no browser or Vite is installed.

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const connection = {
  since: "2026-11-17T10:00:00.000Z",
  percentConnected: 99.4,
  drops: 3,
  longestGapMs: 600_000,
  gaps: [
    { from: "2026-11-23T08:00:00.000Z", to: "2026-11-23T08:10:00.000Z", ms: 600_000, how: "dropped" },
    { from: "2026-11-23T12:00:00.000Z", to: "2026-11-23T12:01:30.000Z", ms: 90_000, how: "server restart" },
    { from: "2026-11-24T09:00:00.000Z", to: null, ms: 45_000, how: "stopped" },
  ],
  shortGaps: 2,
};
const api = {
  ...API,
  "/api/companies/c1/runner": { registered: true, runnerId: "r1", connected: true, connection, lastSeenAt: null, imageVersion: null, diskUsedBytes: null, addons: null },
  "/api/self-deploy/runner-addons": { enabled: false, saved: null, built: null },
};

const PROFILES = [
  { name: "phone-390", width: 390, height: 800, touch: true, ratio: 2 },
  { name: "brave-1667", width: 1667, height: 724, touch: true, ratio: 1 },
  { name: "safari-1550", width: 1550, height: 1000, touch: false, ratio: 1 },
];

type ConnectionHistory = Parameters<typeof connectionToCsv>[0];
const history = (over: Partial<ConnectionHistory> = {}): ConnectionHistory => ({
  since: "2026-11-17T10:00:00.000Z",
  percentConnected: 98,
  drops: 2,
  longestGapMs: 300_000,
  gaps: [
    { from: "2026-11-23T08:00:00.000Z", to: "2026-11-23T08:05:00.000Z", ms: 300_000, how: "dropped" },
    { from: "2026-11-24T09:00:00.000Z", to: null, ms: 45_000, how: null },
  ],
  shortGaps: 1,
  ...over,
});

describe("connectionToCsv (direct)", () => {
  it("leaves a still-open gap's back blank, calls a gap with no reason a connection drop, and puts the summary after a blank line", () => {
    expect(connectionToCsv(history()).split("\r\n")).toEqual([
      "gone,back,length_seconds,length,why",
      "2026-11-23T08:00:00.000Z,2026-11-23T08:05:00.000Z,300,5 min,Connection dropped",
      "2026-11-24T09:00:00.000Z,,45,45 s,Connection dropped",
      "",
      "percent_connected,since,times_dropped,longest_gap_seconds,longest_gap,shorter_gaps_not_listed",
      "98,2026-11-17T10:00:00.000Z,2,300,5 min,1",
      "",
    ]);
  });

  it("says the longest gap is none when nothing dropped and there are no gaps", () => {
    expect(connectionToCsv(history({ percentConnected: null, since: null, drops: 0, longestGapMs: 0, gaps: [], shortGaps: 0 })).split("\r\n")).toEqual([
      "gone,back,length_seconds,length,why",
      "",
      "percent_connected,since,times_dropped,longest_gap_seconds,longest_gap,shorter_gaps_not_listed",
      ",,0,0,none,0",
      "",
    ]);
  });
});

describe.skipIf(!can)("Settings → Runner: connection Download CSV (BOS-2545, real page)", () => {
  for (const p of PROFILES) {
    it(`${p.name}: the button saves the gaps and the summary, and fits the screen`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#settings/c1/runner`, { waitUntil: "networkidle" });
        const root = page.locator("[data-testid=runner-connection]");
        await root.waitFor({ timeout: 15_000 }).catch(async (e: Error) => {
          throw new Error(`${e.message}; body: ${(await page.innerText("body")).slice(0, 400)}`);
        });
        await root.locator("summary").click();
        const button = root.getByRole("button", { name: "Download CSV" });
        await button.waitFor();
        const box = (await button.boundingBox())!;
        const table = (await root.locator("table").boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(p.width);
        // Under the table, not over it.
        expect(box.y).toBeGreaterThanOrEqual(table.y + table.height);
        if (p.touch && p.width < 641) expect(box.height).toBeGreaterThanOrEqual(44);
        if (out) {
          mkdirSync(out, { recursive: true });
          // The picture is proof, not an assertion (BOS-2899). locator.screenshot waits for the element's box to hold
          // still, and on GitHub's slower runners it can time out after its own 30 s and fail the CSV and layout checks
          // above. Stop animations so the box settles, and never let saving the picture fail the test.
          await root.screenshot({ path: path.join(out, `runner-connection-csv-${p.name}.png`), animations: "disabled", timeout: 10_000 }).catch((e: Error) => {
            process.stderr.write(`runner-connection-csv-render: ${p.name} screenshot not saved (checks above passed): ${e.message.split("\n")[0]}\n`);
          });
        }
        const [dl] = await Promise.all([page.waitForEvent("download"), button.click()]);
        expect(dl.suggestedFilename()).toMatch(/^runner-connection-\d{4}-\d{2}-\d{2}\.csv$/);
        expect(readFileSync(await dl.path(), "utf8").split("\r\n")).toEqual([
          "gone,back,length_seconds,length,why",
          "2026-11-23T08:00:00.000Z,2026-11-23T08:10:00.000Z,600,10 min,Connection dropped",
          "2026-11-23T12:00:00.000Z,2026-11-23T12:01:30.000Z,90,1 min,Boss Man restarted",
          "2026-11-24T09:00:00.000Z,,45,45 s,Stopped by you",
          "",
          "percent_connected,since,times_dropped,longest_gap_seconds,longest_gap,shorter_gaps_not_listed",
          "99.4,2026-11-17T10:00:00.000Z,3,600,10 min,2",
          "",
        ]);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  it("no button when there are no gaps", async () => {
    const page = await browser!.newPage({ viewport: { width: 1200, height: 800 } });
    try {
      await stubApi(page, { ...api, "/api/companies/c1/runner": { registered: true, runnerId: "r1", connected: true, connection: { ...connection, gaps: [], drops: 0, longestGapMs: 0, shortGaps: 0 }, lastSeenAt: null, imageVersion: null, diskUsedBytes: null, addons: null } });
      await page.goto(`${server!.resolvedUrls.local[0]}#settings/c1/runner`, { waitUntil: "networkidle" });
      const root = page.locator("[data-testid=runner-connection]");
      await root.waitFor({ timeout: 15_000 });
      await root.locator("summary").click();
      await root.getByText("No gaps of 30 seconds or more.").waitFor();
      expect(await root.getByRole("button", { name: "Download CSV" }).count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
});
