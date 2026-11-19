import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// Real-browser proof shots of the Runs page filters and "Show more" (BOS-1888), at the owner's Brave foldable
// (1667×724 touch), Safari (1550×1611 mouse) and a 390 px phone. With BOSSMAN_SCRATCH set the page is saved at
// each size; without it, or with no browser or Vite installed, the file skips.

const foldable = JSON.parse(readFileSync(new URL("./device-profiles/owner-brave-foldable.json", import.meta.url), "utf8")) as {
  readings: Array<{ width: number; units: { vh: number }; coarsePointer: boolean }>;
};
const fp = foldable.readings[0]!;

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const SIZES = [
  { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "safari-1550", width: 1550, height: 1611, touch: false },
  { name: "brave-1667", width: fp.width, height: fp.units.vh, touch: fp.coarsePointer },
] as const;

const agent = (id: string, name: string, companyId: string) => ({ id, name, companyId, role: "engineer", status: "idle", agentKind: "developer", model: null, paused: false, starred: false });
const companies = [
  { id: "c1", name: "Fernleaf Co", mission: null, paused: false, ticketPrefix: "FER", agents: [agent("a1", "Engineer", "c1"), agent("a2", "Reviewer", "c1")] },
  { id: "c2", name: "Shop Co", mission: null, paused: false, ticketPrefix: "SHP", agents: [agent("a3", "Packer", "c2")] },
];
const run = (n: number, outcome: string) => ({
  id: `run-${n}`,
  companyId: "c1",
  agent: "Engineer",
  agentId: "a1",
  ticketId: null,
  ticket: null,
  model: null,
  startedAt: new Date(Date.UTC(2026, 10, 18, 9) - n * 3_600_000).toISOString(),
  endedAt: new Date(Date.UTC(2026, 10, 18, 10) - n * 3_600_000).toISOString(),
  outcome,
});
const fifty = Array.from({ length: 50 }, (_, i) => run(i, i % 7 === 3 ? "error: check failed" : i % 11 === 5 ? "interrupted" : "end_turn"));

describe.skipIf(!can)("Runs page filters shots (BOS-1888)", () => {
  for (const size of SIZES) {
    it(`shows the filters, a filtered list and Show more at ${size.name}`, async () => {
      const page = (await browser!.newPage({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch })) as any;
      await stubApi(page, { ...API, "/api/companies": companies, "/api/runs/recent": fifty });
      await page.addInitScript(() => localStorage.setItem("bm-side-collapsed", "1"));
      await page.goto(`${server!.resolvedUrls.local[0]}#/runs`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Show more" }).waitFor({ timeout: 15_000 });
      // The phone's company switcher carries the same name, so the filter chip is the last match.
      expect(await page.getByRole("button", { name: "Fernleaf Co" }).count()).toBeGreaterThan(0);
      expect(await page.getByRole("button", { name: "Failed" }).count()).toBe(1);
      if (out) {
        mkdirSync(out, { recursive: true });
        await page.screenshot({ path: path.join(out, `bos1888-${size.name}-runs.png`), fullPage: false });
      }
      await page.getByRole("button", { name: "Fernleaf Co" }).last().click();
      await page.getByRole("button", { name: "Failed" }).click();
      await page.waitForSelector("button[aria-pressed='true']:text-is('Failed')", { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
      if (out) await page.screenshot({ path: path.join(out, `bos1888-${size.name}-filtered.png`), fullPage: false });
      await page.close();
    }, 60_000);
  }
});
