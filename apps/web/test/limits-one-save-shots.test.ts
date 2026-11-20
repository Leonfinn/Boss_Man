import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

// Real-browser check for Settings → Limits (BOS-1944): the in-progress limits and the merge/quick-check holds share
// one Save, which is muted until a field changes, then turns the accent colour with an "Unsaved changes" hint.
// With BOSSMAN_SCRATCH set the screens are saved as proof shots. Skipped, not failed, where no browser or Vite is installed.

const browser = await launch();
const server = browser ? await startVite() : null;
const can = !!(browser && server);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const api = { ...API, "/api/settings/check-queue": { mode: "server", slots: 2, maxSlots: 4, defaultSlots: 2, runnersTooOld: [] },"/api/run-limits": { instance: 4, company: 2, background: 1, defaults: { instance: 4, company: 2, background: 1 } },"/api/wip-limits": { agent: 2, company: null, defaultAgent: 2 } };

const PROFILES = [
  { name: "phone-380", width: 380, height: 800, touch: true, ratio: 2 },
  { name: "desktop-1550", width: 1550, height: 1000, touch: false, ratio: 1 },
];

describe.skipIf(!can)("Settings → Limits: one Save (BOS-1944)", () => {
  for (const p of PROFILES) {
    it(`renders at ${p.name}`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.ratio, hasTouch: p.touch, isMobile: p.touch });
      try {
        await stubApi(page, api);
        await page.goto(`${server!.resolvedUrls.local[0]}#settings/c1/limits`, { waitUntil: "networkidle" });
        await page.waitForSelector("#wip-company", { timeout: 15_000 }).catch(async (e: Error) => {
          throw new Error(`${e.message}; body: ${(await page.innerText("body")).slice(0, 400)}`);
        });
        const section = page.locator("#wip-limits-h").locator("xpath=ancestor::section[1]");
        const saves = section.getByRole("button", { name: /^Save/ });
        expect(await saves.count()).toBe(1);
        expect(await saves.first().isDisabled()).toBe(true);
        expect(await saves.first().getAttribute("class")).not.toContain("primary");
        if (out) {
          mkdirSync(out, { recursive: true });
          await section.screenshot({ path: path.join(out, `limits-clean-${p.name}.png`) });
        }
        await page.fill("#wip-company", "6");
        expect(await saves.first().getAttribute("class")).toContain("primary");
        expect(await section.getByTestId("unsaved-hint").count()).toBe(1);
        if (out) await section.screenshot({ path: path.join(out, `limits-unsaved-${p.name}.png`) });
        await page.fill("#wip-company", "");
        expect(await saves.first().isDisabled()).toBe(true);
        expect(await section.getByTestId("unsaved-hint").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
