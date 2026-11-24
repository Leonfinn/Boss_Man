import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport } from "@boss-man/shared";

// BOS-2521: a real-browser render check of the Features toolbar's "Unfinished setup" switch and the setup tags on a
// row, at a desktop width and at each recorded device profile. It is the markup the page builds (the same label and
// the same .tag amber spans), put in a headless browser with the real styles.css. Skipped, not failed, where no
// browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const tags = (title: string, gaps: string[]) =>
  gaps.length
    ? `<span class="feature-setup" style="display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 6px">${gaps
        .map((g) => `<span class="tag amber">${g}</span>`)
        .join("")}</span>`
    : "";

const toolbar = `<section class="card features-toolbar"><div class="features-toolbar-tools">
<label style="display: flex; gap: 6px; align-items: center">Search features <input type="search" class="mini" placeholder="Title or description"></label>
<label style="display: flex; gap: 6px; align-items: center">Sort by <select class="mini"><option>Priority</option></select></label>
<label style="display: flex; gap: 6px; align-items: center"><input type="checkbox"> Stalled only</label>
<label style="display: flex; gap: 6px; align-items: center" title="Features with no size, no place on the roadmap, or no portal decision"><input type="checkbox" checked> Unfinished setup <span class="muted" data-count>4 features need setup</span></label>
<label style="display: flex; gap: 6px; align-items: center"><input type="checkbox"> Show released and declined</label>
<button type="button" class="link" style="padding: 0">Expand all</button>
<a href="#" style="margin-left: auto">Feedback inbox</a>
<button type="button" class="btn small">Download CSV</button>
<button type="button" class="btn small">Criteria and areas</button>
</div></section>`;

const row = (title: string, gaps: string[]) => `<tr>
<td class="feature-name"><span style="display: inline-flex; align-items: center; gap: 6px"><a href="#">${title}</a></span>${tags(title, gaps)}</td>
<td><input type="checkbox" checked></td>
<td><span class="tag amber">In progress</span></td>
<td class="muted" style="white-space: nowrap">today</td>
<td class="mono" style="white-space: nowrap">2 <small class="muted"> (1)</small></td>
<td><select class="mini"><option>3</option></select></td>
<td class="mono">3.5</td>
<td class="mono">7.5</td>
<td class="mono muted" style="white-space: nowrap">–</td>
</tr>`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main { padding: 16px; }
</style></head><body><main>
${toolbar}
<p class="muted" data-empty>Every feature is set up</p>
<div class="table-wrap"><table class="features">
<thead><tr><th class="feature-name">Feature</th><th>Portal</th><th>Status</th><th>Last moved</th><th>Demand</th><th>Effort</th><th>Value</th><th>Priority</th><th>Work</th></tr></thead>
<tbody>
${row("A feature that is fully set up", [])}
${row("A feature missing its size only", ["No size"])}
${row("A feature missing several things at once for a long row", ["No size", "Not on the roadmap", "Portal not decided"])}
</tbody>
</table></div>
</main></body></html>`;

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
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
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

const scratch = process.env.BOSSMAN_SCRATCH;
const shot = scratch ? (await import("node:path")).join(scratch, `features-setup-${process.env.BOSSMAN_SHOT_TAG ?? "after"}`) : null;

type Measure = {
  scrollWidth: number;
  innerWidth: number;
  switchVisible: boolean;
  tagsVisible: boolean;
  tagTexts: string[];
  tagRows: string[];
};

const measure = () => {
  const scrollWidth = document.documentElement.scrollWidth;
  const innerWidth = window.innerWidth;
  const box = document.querySelector('[title*="no place on the roadmap"]') as HTMLElement | null;
  const tags = [...document.querySelectorAll(".feature-setup .tag")]
    .filter((t) => (t as HTMLElement).getBoundingClientRect().height > 0)
    .map((t) => t.textContent?.trim() ?? "");
  const tagRows = [...document.querySelectorAll("tr")]
    .filter((tr) => tr.querySelector(".feature-setup .tag"))
    .map((tr) => tr.querySelector("a")?.textContent?.trim() ?? "");
  return {
    scrollWidth,
    innerWidth,
    switchVisible: !!box && box.getBoundingClientRect().height > 0,
    tagsVisible: tags.length > 0,
    tagTexts: tags,
    tagRows,
  };
};

describe.skipIf(!browser)("Features unfinished setup shows at every size (BOS-2521)", () => {
  it("has a recorded device profile to render at", () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it("desktop 1280: the switch and the tags are visible, named, and the page does not scroll sideways", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const m = (await page.evaluate(measure)) as Measure;
      expect(m.switchVisible).toBe(true);
      expect(m.tagsVisible).toBe(true);
      expect(m.tagTexts).toEqual(["No size", "No size", "Not on the roadmap", "Portal not decided"]);
      expect(m.tagRows).toEqual(["A feature missing its size only", "A feature missing several things at once for a long row"]);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
    } finally {
      await page.close();
    }
  });

  for (const p of profiles) {
    it(`${p.file}: the switch and tags fit at the recorded profile`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.deviceScaleFactor, hasTouch: p.hasTouch, isMobile: p.hasTouch });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        const m = (await page.evaluate(measure)) as Measure;
        expect(m.switchVisible).toBe(true);
        expect(m.tagTexts).toContain("Portal not decided");
        // A wide table scrolls inside its card, never sideways on the page.
        expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth + 1);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  it.skipIf(!shot)("saves screenshots to the scratch folder when asked", async () => {
    for (const [tag, p] of [["desktop", { width: 1280, height: 900, deviceScaleFactor: 1, hasTouch: false }], ...profiles.map((x) => [x.file, x] as const)] as const) {
      const size = "width" in p ? p : { width: 1280, height: 900, deviceScaleFactor: 1, hasTouch: false };
      const page = await browser!.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.deviceScaleFactor, hasTouch: size.hasTouch, isMobile: size.hasTouch });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        await page.screenshot({ path: `${shot}-${tag}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    }
    expect(shot).toContain("features-setup-");
  });
});
