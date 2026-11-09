import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { DeviceReport } from "@boss-man/shared";

// A rendering check of the Features list (BOS-956), not a CSS-text test: every feature's tasks now
// fold behind an arrow, the WORK column reads "8 of 9 complete", and the row and its open task list
// must sit inside the window at a desktop width and at the owner's recorded foldable profile, folded
// and open. The same markup FeatureRow renders is put in a headless browser with the real styles.css.
// Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const features = [
  {
    id: "f1",
    title: "A feature with plenty of tasks to fold away",
    summary: "8 of 10 complete · 2 blocked",
    tasks: Array.from({ length: 10 }, (_, i) => ({ title: `A task delivering the feature, number ${i + 1}`, state: i < 8 ? "done" : "blocked", assignee: i % 2 ? "Sooty - Designer" : "Bungle - Web Developer" })),
  },
  { id: "f2", title: "A feature with no tasks at all", summary: "–", tasks: [] },
];

const row = (f: (typeof features)[number], open: boolean) => {
  const foldable = f.tasks.length > 0;
  return `<tbody>
<tr>
<td style="min-width: 220px"><span style="display: inline-flex; align-items: center; gap: 6px">
${
  foldable
    ? `<button type="button" class="feature-fold" aria-expanded="${open}" aria-controls="feature-tasks-${f.id}" aria-label="${open ? "Hide" : "Show"} tasks of ${f.title}" data-toggle="${f.id}"><span class="pl-arrow" aria-hidden="true">${open ? "▾" : "▸"}</span></button>`
    : ""
}
<a href="#">${f.title}</a>
</span></td>
<td><select class="mini" aria-label="Status"><option>In progress</option></select></td>
<td class="mono" style="white-space: nowrap"><span class="bar" style="width: 64px; display: inline-block; vertical-align: middle" aria-label="Demand 0"><span style="width: 0%"></span></span> 0 <small class="muted"> (0)</small></td>
<td><select class="mini" aria-label="Effort"><option>–</option></select></td>
<td class="mono">0.0</td>
<td class="mono"><b>0.0</b></td>
<td class="mono muted" style="white-space: nowrap">${foldable ? `<button type="button" class="feature-fold feature-work" aria-expanded="${open}" aria-controls="feature-tasks-${f.id}" data-toggle="${f.id}">${f.summary}</button>` : f.summary}</td>
</tr>
${
  foldable
    ? `<tr id="feature-tasks-${f.id}"${open ? "" : " hidden"}><td colspan="7" style="padding-left: 32px"><ul class="link-list" aria-label="Tasks of ${f.title}">
${f.tasks.map((t) => `<li><a href="#">${t.title}</a><span class="tag ${t.state === "done" ? "green" : "amber"}">${t.state}</span><span class="muted">${t.assignee}</span></li>`).join("\n")}
</ul></td></tr>`
    : ""
}
</tbody>`;
};

const HTML = (open: boolean) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}
body { margin: 0; } main { padding: 16px; }
</style></head><body><main><div class="table-wrap"><table class="features">
<thead><tr><th>Feature</th><th>Status</th><th>Demand</th><th>Effort</th><th>Value</th><th>Priority</th><th>Work</th></tr></thead>
${features.map((f) => row(f, open)).join("\n")}
</table></div></main>
<script>
  for (const b of document.querySelectorAll("[data-toggle]")) b.addEventListener("click", () => {
    const row = document.getElementById("feature-tasks-" + b.dataset.toggle);
    if (!row) return;
    row.hidden = !row.hidden;
    for (const t of document.querySelectorAll('[data-toggle="' + b.dataset.toggle + '"]')) t.setAttribute("aria-expanded", String(!row.hidden));
  });
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

// Opt-in before/after proof: with BOSSMAN_SCRATCH set, save full-page screenshots at the desktop
// window and the owner's foldable profile. Never a repo file (the ticket says proofs go to scratch).
const scratch = process.env.BOSSMAN_SCRATCH;
const shot = scratch ? (await import("node:path")).join(scratch, `features-fold-${process.env.BOSSMAN_SHOT_TAG ?? "after"}`) : null;

type Measure = {
  tasksVisible: boolean;
  arrowExpanded: string | null;
  workText: string;
  wrapScrolls: boolean;
  scrollWidth: number;
  innerWidth: number;
  noTaskArrow: boolean;
};

const measure = () => {
  const taskRow = document.getElementById("feature-tasks-f1") as HTMLElement | null;
  const arrow = document.querySelector('[data-toggle="f1"]') as HTMLElement | null;
  const work = document.querySelector(".feature-work") as HTMLElement | null;
  const wrap = document.querySelector(".table-wrap") as HTMLElement;
  return {
    tasksVisible: !!taskRow && taskRow.getBoundingClientRect().height > 0 && !taskRow.hidden,
    arrowExpanded: arrow?.getAttribute("aria-expanded") ?? null,
    workText: work?.textContent?.trim() ?? "",
    // A wide table scrolls inside the card, never sideways on the page.
    wrapScrolls: getComputedStyle(wrap).overflowX === "auto" && wrap.scrollWidth > wrap.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    noTaskArrow: !!document.querySelector('[data-toggle="f2"]'),
  };
};

describe.skipIf(!browser)("feature tasks fold behind an arrow (BOS-956)", () => {
  it("has a recorded device profile to render at", () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it("desktop 1280: folded by default with the summary, and the arrow opens the tasks", async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.setContent(HTML(false), { waitUntil: "load" });
      const folded = (await page.evaluate(measure)) as Measure;
      expect(folded.tasksVisible).toBe(false);
      expect(folded.arrowExpanded).toBe("false");
      expect(folded.workText).toBe("8 of 10 complete · 2 blocked");
      expect(folded.noTaskArrow).toBe(false);
      expect(folded.scrollWidth).toBeLessThanOrEqual(folded.innerWidth + 1);

      await page.evaluate(() => (document.querySelector('[data-toggle="f1"]') as HTMLElement).click());
      const open = (await page.evaluate(measure)) as Measure;
      expect(open.tasksVisible).toBe(true);
      expect(open.arrowExpanded).toBe("true");
      expect(open.scrollWidth).toBeLessThanOrEqual(open.innerWidth + 1);
    } finally {
      await page.close();
    }
  });

  for (const p of profiles) {
    it(`${p.file}: folded and open both fit the window`, async () => {
      const page = await browser!.newPage({ viewport: { width: p.width, height: p.height }, deviceScaleFactor: p.deviceScaleFactor, hasTouch: p.hasTouch, isMobile: p.hasTouch });
      try {
        await page.setContent(HTML(false), { waitUntil: "load" });
        const folded = (await page.evaluate(measure)) as Measure;
        expect(folded.tasksVisible).toBe(false);
        expect(folded.scrollWidth).toBeLessThanOrEqual(folded.innerWidth + 1);

        await page.evaluate(() => (document.querySelector('[data-toggle="f1"]') as HTMLElement).click());
        const open = (await page.evaluate(measure)) as Measure;
        expect(open.tasksVisible).toBe(true);
        expect(open.scrollWidth).toBeLessThanOrEqual(open.innerWidth + 1);
      } finally {
        await page.close();
      }
    }, 30_000);
  }

  it.skipIf(!shot)("saves before (folded) and after (open) screenshots to the scratch folder when asked", async () => {
    for (const [tag, open] of [["before", false], ["after", true]] as const) {
      const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
      try {
        await page.setContent(HTML(open), { waitUntil: "load" });
        await page.screenshot({ path: `${shot}-desktop-${tag}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    }
    const foldable = profiles.find((p) => p.file.startsWith("owner-")) ?? profiles[0];
    if (foldable) {
      for (const [tag, open] of [["before", false], ["after", true]] as const) {
        const page = await browser!.newPage({ viewport: { width: foldable.width, height: foldable.height }, deviceScaleFactor: foldable.deviceScaleFactor, hasTouch: foldable.hasTouch, isMobile: foldable.hasTouch });
        try {
          await page.setContent(HTML(open), { waitUntil: "load" });
          await page.screenshot({ path: `${shot}-foldable-${tag}.png`, fullPage: true });
        } finally {
          await page.close();
        }
      }
    }
    expect(shot).toContain("features-fold-");
  });
});
