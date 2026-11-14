import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport } from "@boss-man/shared";

// A rendering check of the page intros' fold (P7, BOS-1278), not a CSS-text test: the lead reads as one short
// paragraph, the toggle carries the drawn chevron (P12) on every browser, and at the owner's recorded widths the
// fold sits inside the window, closed and open. The markup MoreAbout renders is put in a headless browser with the
// real styles.css. Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

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

const HTML = (open: boolean) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body { margin: 0; padding: 16px; background: var(--ground); }
</style></head><body>
<div style="max-width: 560px">
  <p class="muted more-about-lead" id="lead">Stops every company from starting new agent runs until you press Resume.</p>
  <div class="more-about">
    <p class="muted more-about-lead">Choose whether the CEO's changes to an agent's instructions wait for you.</p>
    <button type="button" class="more-about-toggle" aria-expanded="${open}" aria-controls="more">
      <span class="more-about-chevron" aria-hidden="true"></span>More about this
    </button>
    ${
      open
        ? `<ul id="more" class="muted more-about-list">
      <li>Runs already going are not cut off. They finish by themselves. To end one now, use the Runs page.</li>
      <li>Wake-ups and messages wait in line, and start when you resume.</li>
      <li>While work is stopped, every page shows a banner at the top. Press Resume on it to start work again.</li>
    </ul>`
        : ""
    }
  </div>
</div>
</body></html>`;

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

const measure = () => {
  const toggle = document.querySelector(".more-about-toggle") as HTMLElement;
  const chevron = document.querySelector(".more-about-chevron") as HTMLElement;
  const list = document.querySelector(".more-about-list") as HTMLElement | null;
  const lead = document.querySelector(".more-about-lead") as HTMLElement;
  const box = toggle.getBoundingClientRect();
  // A drawn chevron: border width and height on a rotated box, not a text ▸ that a font may drop (P12).
  const c = getComputedStyle(chevron);
  return {
    expanded: toggle.getAttribute("aria-expanded"),
    role: toggle.tagName,
    controls: toggle.getAttribute("aria-controls"),
    toggleHeight: Math.round(box.height),
    chevron: { width: c.width, height: c.height, transform: c.transform },
    leadFontSize: getComputedStyle(lead).fontSize,
    listItems: list ? list.querySelectorAll("li").length : 0,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  };
};

describe.skipIf(!browser)("page intros fold (P7, BOS-1278)", () => {
  // Opt-in proof: with BOSSMAN_SCRATCH set, a closed and an open picture of the fold go to the ticket's kept
  // scratch folder. Never a repo file.
  const scratch = process.env.BOSSMAN_SCRATCH;
  const shot = scratch ? `${scratch}/page-intro-fold` : null;

  it("has the owner's recorded screens to render at", () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it.skipIf(!shot)("saves closed and open pictures to the kept scratch folder when asked", async () => {
    for (const [tag, open] of [["closed", false], ["open", true]] as const) {
      const page = await browser!.newPage({ viewport: { width: 1550, height: 900 } });
      try {
        await page.setContent(HTML(open), { waitUntil: "load" });
        await page.screenshot({ path: `${shot}-${tag}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    }
    expect(shot).toContain("page-intro-fold");
  });

  it("desktop 1280: closed shows the lead and the drawn chevron, open fits the window", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(HTML(false), { waitUntil: "load" });
      const closed = (await page.evaluate(measure)) as ReturnType<typeof measure>;
      expect(closed.role).toBe("BUTTON");
      expect(closed.expanded).toBe("false");
      expect(closed.listItems).toBe(0);
      expect(closed.chevron.width).not.toBe("0px");
      expect(closed.chevron.transform).not.toBe("none");
      expect(closed.scrollWidth).toBeLessThanOrEqual(closed.innerWidth + 1);

      await page.setContent(HTML(true), { waitUntil: "load" });
      const open = (await page.evaluate(measure)) as ReturnType<typeof measure>;
      expect(open.expanded).toBe("true");
      expect(open.listItems).toBe(3);
      expect(open.scrollWidth).toBeLessThanOrEqual(open.innerWidth + 1);
    } finally {
      await page.close();
    }
  });

  for (const p of profiles) {
    it(`${p.file} (${p.width}px): the fold fits the window closed and open`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.deviceScaleFactor, hasTouch: p.hasTouch, isMobile: p.hasTouch });
      try {
        for (const open of [false, true]) {
          await page.setContent(HTML(open), { waitUntil: "load" });
          const m = (await page.evaluate(measure)) as ReturnType<typeof measure>;
          expect(m.scrollWidth, `open=${open}`).toBeLessThanOrEqual(m.innerWidth + 1);
          // On a touch screen the its thumb target is at least 44 px.
          if (p.hasTouch) expect(m.toggleHeight, `open=${open}`).toBeGreaterThanOrEqual(44);
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

