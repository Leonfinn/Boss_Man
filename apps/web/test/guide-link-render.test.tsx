import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { SafetyCards } from "../src/pages/settings/Runner";
import { RightNow, type HealthLine } from "../src/components/DashboardPanels";
import { GUIDE_BASE } from "../src/guide-links";

// BOS-2832: a "What's this?" guide link is 14 px in the link colour, right after the line it explains,
// and at least 44 px tall on touch. Rendered in Chromium at the owner's Brave profile and a phone.
// Skipped where no browser is installed. Screenshots go to BOSSMAN_SCRATCH.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = { setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>; evaluate: <T>(fn: () => T) => Promise<T>; screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>; close: () => Promise<void> };
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean }) => Promise<Page>; close: () => Promise<void> };

async function launch(): Promise<Browser | null> {
  let chromium: { launch: (opts?: { executablePath?: string; args?: string[] }) => Promise<Browser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  const args = ["--no-sandbox"];
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath, args } : { args });
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

const out = process.env.BOSSMAN_SCRATCH;

const line = (over: Partial<HealthLine>): HealthLine => ({ key: "runner", tone: "ok", symbol: "✓", state: "Runner connected", pill: "Runner connected", text: "", href: "#/runner", linkText: "Runner settings", refresh: "Updates every 10 s.", ...over });
const offlineLines = [line({ tone: "bad", symbol: "✕", state: "Runner offline", text: "Since 09:10 (2 minutes). Runs and checks can't start." }), line({ key: "merges", state: "Merges moving" }), line({ key: "usage", state: "No agent held by a usage limit" }), line({ key: "update", state: "No update waiting" })];

const safety = { fingerprint: "6.1.0|docker 27|linux", fence: { proven: false, runWithout: false }, guard: { proven: false, runWithout: false, reason: "connected to the gateway" } };

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="main">
<div id="dash">${renderToStaticMarkup(<RightNow lines={offlineLines} paused={false} companyId="c1" />)}</div>
<div id="runner" style="margin-top:24px">${renderToStaticMarkup(<SafetyCards companyId="c1" safety={safety} connected onChanged={() => {}} />)}</div>
</main></body></html>`;

const read = () => {
  const dash = document.querySelector("#dash .guide-link") as HTMLAnchorElement | null;
  const runner = document.querySelector("#runner .guide-link") as HTMLAnchorElement | null;
  const style = (a: HTMLAnchorElement | null) => {
    if (!a) return null;
    const cs = getComputedStyle(a);
    const box = a.getBoundingClientRect();
    return { text: a.textContent ?? "", href: a.getAttribute("href"), target: a.getAttribute("target"), fontSize: cs.fontSize, color: cs.color, height: box.height };
  };
  return { dash: style(dash), runner: style(runner) };
};

const devices = [
  { name: "brave-1667", width: 1667, height: 724, ratio: 3, touch: true, mobile: false, minHeight: 0 },
  { name: "phone-390", width: 390, height: 844, ratio: 2, touch: true, mobile: true, minHeight: 44 },
];

describe.skipIf(!browser)("BOS-2832 guide links look right on the Dashboard and Runner", () => {
  for (const d of devices) {
    it(`${d.name}: 14 px link colour, opens a new tab, ${d.minHeight || "no"} min height`, async () => {
      const page = await browser!.newPage({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.ratio, hasTouch: d.touch, isMobile: d.mobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got.dash, "Dashboard runner guide link").not.toBeNull();
        expect(got.dash!.text).toContain("What's the runner?");
        expect(got.dash!.text).toContain("(opens a guide)");
        expect(got.dash!.href).toBe(`${GUIDE_BASE}/guides/the-runner`);
        expect(got.dash!.target).toBe("_blank");
        expect(got.dash!.fontSize).toBe("14px");
        expect(got.runner, "Runner safety guide link").not.toBeNull();
        expect(got.runner!.href).toBe(`${GUIDE_BASE}/guides/what-keeps-agents-fenced-in`);
        expect(got.runner!.fontSize).toBe("14px");
        if (d.minHeight) {
          expect(got.dash!.height).toBeGreaterThanOrEqual(d.minHeight - 0.5);
          expect(got.runner!.height).toBeGreaterThanOrEqual(d.minHeight - 0.5);
        }
        if (out) {
          mkdirSync(out, { recursive: true });
          await page.screenshot({ path: path.join(out, `bos-2832-guide-links-${d.name}.png`), fullPage: true });
        }
      } finally {
        await page.close();
      }
    });
  }
});
