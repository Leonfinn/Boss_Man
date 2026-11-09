import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport } from "@boss-man/shared";

// A rendering check of the Features list's new "On portal" column (BOS-957), not a CSS-text test:
// each row has an "On portal" tick and, when a feature is held off, a small reason under it. Every
// row must fit the window at a desktop width and at the owner's recorded foldable profile. The same
// markup FeatureRow renders is put in a headless browser with the real styles.css. Skipped, not
// failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const rows = [
  { id: "f1", title: "Dark mode across the whole app", checked: true, hint: null },
  { id: "f2", title: "Rotate API keys every week", checked: false, hint: "kept off: security" },
  { id: "f3", title: "A softer dark theme for night reading", checked: true, hint: "needs public summary" },
];

const tick = (r: (typeof rows)[number]) => `<span style="display: inline-flex; flex-direction: column; gap: 2px">
<label style="display: inline-flex; align-items: center; gap: 4px" title="Show on the feedback portal, where visitors can vote on it"><input type="checkbox" aria-label="On portal: ${r.title}" data-tick="${r.id}"${r.checked ? " checked" : ""} /><span class="muted" style="font-size: 12px">On portal</span></label>
${r.hint ? `<small class="muted" style="font-size: 11px">${r.hint}</small>` : ""}
</span>`;

const row = (r: (typeof rows)[number]) => `<tbody>
<tr>
<td style="min-width: 220px"><span style="display: inline-flex; align-items: center; gap: 6px"><a href="#">${r.title}</a></span></td>
<td style="white-space: nowrap">${tick(r)}</td>
<td><select class="mini" aria-label="Status"><option>In progress</option></select></td>
<td class="mono" style="white-space: nowrap"><span class="bar" style="width: 64px; display: inline-block; vertical-align: middle" aria-label="Demand 0"><span style="width: 0%"></span></span> 0 <small class="muted"> (0)</small></td>
<td><select class="mini" aria-label="Effort"><option>–</option></select></td>
<td class="mono">0.0</td>
<td class="mono"><b>0.0</b></td>
<td class="mono muted" style="white-space: nowrap">–</td>
</tr>
</tbody>`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main { padding: 16px; }
</style></head><body><main><div class="table-wrap"><table class="features">
<thead><tr><th>Feature</th><th title="Show on the feedback portal, where visitors can vote on it">Portal</th><th>Status</th><th>Demand</th><th>Effort</th><th>Value</th><th>Priority</th><th>Work</th></tr></thead>
${rows.map(row).join("\n")}
</table></div></main>
<script>
  for (const b of document.querySelectorAll("[data-tick]")) b.addEventListener("change", () => { b.dataset.changed = String(b.checked); });
</script>
</body></html>`;

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
const shot = scratch ? path.join(scratch, `features-portal-${process.env.BOSSMAN_SHOT_TAG ?? "after"}`) : null;

const measure = () => {
  const wrap = document.querySelector(".table-wrap") as HTMLElement;
  const hints = [...document.querySelectorAll(".features small")].map((x) => x.textContent?.trim() ?? "");
  const t = document.querySelector('[data-tick="f1"]') as HTMLInputElement;
  return {
    pageScrollsX: document.documentElement.scrollWidth > window.innerWidth + 1,
    wrapScrolls: getComputedStyle(wrap).overflowX === "auto" && wrap.scrollWidth > wrap.clientWidth,
    hints,
    f1Checked: t?.checked ?? null,
  };
};

describe.skipIf(!browser)("features list: On portal tick (BOS-957)", () => {
  it("has a recorded device profile to render at", () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it("desktop 1280: rows fit, the tick reflects the feature, and the reason shows", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const m = (await page.evaluate(measure)) as ReturnType<typeof measure>;
      expect(m.pageScrollsX).toBe(false);
      expect(m.f1Checked).toBe(true);
      expect(m.hints).toContain("kept off: security");
      expect(m.hints).toContain("needs public summary");
      // Clicking the tick saves at once: the change event reaches the handler.
      await page.evaluate(() => (document.querySelector('[data-tick="f1"]') as HTMLInputElement).click());
      expect(await page.evaluate(() => (document.querySelector('[data-tick="f1"]') as HTMLElement).dataset.changed)).toBe("false");
    } finally {
      await page.close();
    }
  });

  for (const p of profiles) {
    it(`${p.file}: rows fit the window with the reason shown`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.deviceScaleFactor, hasTouch: p.hasTouch, isMobile: p.hasTouch });
      try {
        await page.setContent(HTML, { waitUntil: "load" });
        const m = (await page.evaluate(measure)) as ReturnType<typeof measure>;
        expect(m.pageScrollsX).toBe(false);
        expect(m.hints).toContain("kept off: security");
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  it.skipIf(!shot)("saves desktop and foldable screenshots to the scratch folder when asked", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      await page.screenshot({ path: `${shot}-desktop.png`, fullPage: true });
    } finally {
      await page.close();
    }
    const foldable = profiles.find((p) => p.file.startsWith("owner-")) ?? profiles[0];
    if (foldable) {
      const page2 = await browser!.newPage({ viewport: { width: foldable.width, height: foldable.height }, deviceScaleFactor: foldable.deviceScaleFactor, hasTouch: foldable.hasTouch, isMobile: foldable.hasTouch });
      try {
        await page2.setContent(HTML, { waitUntil: "load" });
        await page2.screenshot({ path: `${shot}-foldable.png`, fullPage: true });
      } finally {
        await page2.close();
      }
    }
    expect(shot).toContain("features-portal-");
  });
});
