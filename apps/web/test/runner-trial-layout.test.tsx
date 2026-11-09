import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport } from "@boss-man/shared";
import { TrialLines } from "../src/pages/Settings";

// A rendering check of the Updates panel's trial and rate-limit lines (BOS-953), not a CSS-text test:
// the same markup the panel renders, with the real styles.css, in a headless browser at a desktop
// width and at the owner's recorded foldable profile. Each line must be visible and sit inside the
// window (no sideways scroll, no line cut off). Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const now = Date.parse("2026-11-09T15:27:00Z");
const markup = renderToStaticMarkup(
  <section className="section">
    <h2>Updates</h2>
    <p style={{ fontSize: 14 }}>Last deploy: deployed, server aaaaaaaa, 9 Nov 15:18. Switched in.</p>
    <p className="muted" style={{ fontSize: 14 }}>Up to date as of 9 Nov 15:27.</p>
    <TrialLines trial={{ endsAt: "2026-11-09T15:33:00Z" }} wait={{ until: "2026-11-09T15:31:00Z" }} now={now} />
  </section>,
);
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main { padding: 16px; } .section { max-width: 900px; }
</style></head><body><main>${markup}</main></body></html>`;

const profiles = (() => {
  const dir = new URL("./device-profiles/", import.meta.url);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, parsed: DeviceReport.parse(JSON.parse(readFileSync(new URL(f, dir), "utf8"))) }))
      .map((p) => {
        const r = p.parsed.readings.find((x) => x.afterScroll) ?? p.parsed.readings[0]!;
        return { file: p.file, width: r.width, height: r.height, deviceScaleFactor: r.pixelRatio, hasTouch: r.coarsePointer };
      });
  } catch {
    return [];
  }
})();

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path?: string; fullPage?: boolean }) => Promise<Buffer>;
  close: () => Promise<void>;
};
type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean }) => Promise<Page>;
  close: () => Promise<void>;
};

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

// Opt-in before/after proof (the ticket wants desktop and phone-width shots): with BOSSMAN_SCRATCH set,
// save them there. Never a repo file; proofs don't go in the repo.
const scratch = process.env.BOSSMAN_SCRATCH;

type Measure = { trialVisible: boolean; waitVisible: boolean; trialFits: boolean; waitFits: boolean; pageScrolls: boolean; scrollWidth: number; innerWidth: number; trialText: string; waitText: string };

const measure = (): Measure => {
  const trial = document.querySelector('[data-testid="runner-trial"]') as HTMLElement | null;
  const wait = document.querySelector('[data-testid="deploy-wait"]') as HTMLElement | null;
  const fits = (el: HTMLElement | null) => !!el && el.getBoundingClientRect().height > 0 && el.scrollWidth <= el.clientWidth + 1;
  return {
    trialVisible: !!trial && trial.getBoundingClientRect().height > 0,
    waitVisible: !!wait && wait.getBoundingClientRect().height > 0,
    trialFits: fits(trial),
    waitFits: fits(wait),
    pageScrolls: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    trialText: trial?.textContent ?? "",
    waitText: wait?.textContent ?? "",
  };
};

describe.skipIf(!browser)("Updates trial line fits the window (BOS-953)", () => {
  it("has a recorded device profile to render at", () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it("desktop 1280: both lines are visible and inside the window", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      if (scratch) await page.screenshot({ path: `${scratch}/trial-desktop.png`, fullPage: true });
      const m = (await page.evaluate(measure)) as Measure;
      expect(m.trialVisible).toBe(true);
      expect(m.waitVisible).toBe(true);
      expect(m.trialText).toContain("Runners can be updated from");
      expect(m.waitText).toContain("You can deploy again from");
      expect(m.trialFits).toBe(true);
      expect(m.waitFits).toBe(true);
      expect(m.pageScrolls).toBe(false);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
    } finally {
      await page.close();
    }
  });

  it("phone 380: both lines wrap and stay inside the window", async () => {
    const page = await browser!.newPage({ viewport: { width: 380, height: 800 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      if (scratch) await page.screenshot({ path: `${scratch}/trial-phone-380.png`, fullPage: true });
      const m = (await page.evaluate(measure)) as Measure;
      expect(m.trialVisible).toBe(true);
      expect(m.waitVisible).toBe(true);
      expect(m.trialFits).toBe(true);
      expect(m.waitFits).toBe(true);
      expect(m.scrollWidth).toBeLessThanOrEqual(380 + 1);
    } finally {
      await page.close();
    }
  });

  for (const p of profiles) {
    it(`${p.file} (${p.width}px): both lines fit the window`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.deviceScaleFactor, hasTouch: p.hasTouch, isMobile: p.hasTouch });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        const m = (await page.evaluate(measure)) as Measure;
        expect(m.trialVisible).toBe(true);
        expect(m.waitVisible).toBe(true);
        expect(m.trialFits).toBe(true);
        expect(m.waitFits).toBe(true);
        expect(m.scrollWidth).toBeLessThanOrEqual(p.width + 1);
      } finally {
        await page.close();
      }
    });
  }
});
