import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { AdviceLines } from "../src/pages/settings/ThisHost";
import type { HostFactsView } from "../src/host-facts-display";

// A rendering check of the three lines under each warning on Settings → This host (BOS-2674): does it matter, what
// Boss Man is doing, do you need to do anything. The real AdviceLines component is rendered with the real styles.css in a
// headless browser at the owner's devices and a phone width; the words must be on screen and nothing may run off the box.
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number }) => Promise<Page>; close: () => Promise<void> };

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
const d: HostFactsView = {
  hostName: "host-a",
  reportedAt: "2026-11-26T11:49:00Z",
  ownerFacts: [],
  facts: {},
  impact: { runnersTotal: 1, runnersConnected: 1, runsGoing: 2 },
  handling: { "check.container_status.unhealthy": { state: "ceo_told", reports: 3, since: "2026-11-26T11:40:00Z", ticket: { ref: "BOS-9", title: "Fix the unhealthy container" } } },
};
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main"><div class="muted" style="font-size:13px"><ul style="margin:0;padding-left:18px"><li>1 container is restarting or unhealthy: example-app. a container that keeps restarting is failing its own health check. The next update restarts the stack.${renderToStaticMarkup(<AdviceLines k="check.container_status.unhealthy" d={d} />)}</li></ul></div></main></body></html>`;

const read = () => {
  const box = document.querySelector('[data-testid="warning-advice"]') as HTMLElement;
  const li = box.closest("li") as HTMLElement;
  return { text: box.innerText, rows: box.children.length, overflow: li.scrollWidth - li.clientWidth, insideX: box.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5 };
};

describe.skipIf(!browser)("This host warning advice in a real browser (BOS-2674)", () => {
  for (const dev of [
    { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
    { name: "brave-1667", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3 },
    { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  ]) {
    it(`${dev.name}: the three lines are on screen and stay inside the panel`, async () => {
      const page = await browser!.newPage({ viewport: dev.viewport, deviceScaleFactor: dev.deviceScaleFactor });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got.rows).toBe(3);
        expect(got.text).toContain("Does it matter?");
        expect(got.text).toContain("No runner is affected");
        expect(got.text).toContain("Ticket BOS-9: Fix the unhealthy container.");
        expect(got.text).toContain("BOS-9 is open for it, not assigned yet. The CEO was alerted: raised, nobody has picked it up yet.");
        expect(got.text).toContain("Do you need to do anything? No.");
        expect(got.overflow).toBeLessThanOrEqual(1);
        expect(got.insideX).toBe(true);
        if (scratch) await page.screenshot({ path: `${scratch}/this-host-advice-${dev.name}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
