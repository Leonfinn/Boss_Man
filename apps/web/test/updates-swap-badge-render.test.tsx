import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { LiveState, historyTag, runnerProgress, type HistoryRow, type LiveRow, type MaintenanceView } from "../src/pages/settings/updates";

// BOS-2546: the swap badge measured "done" against the newest image any runner reports, so with every runner still on
// the old image it read "3 of 3 done". It now measures against the image the update is for. This renders the badge and
// the "Now running" list with the real styles.css in headless Chromium at a owner's two desktop widths (1667, 1550) and a 390 px phone
// and checks that the badge, the list tags and the page width agree. It renders these two components by hand, not the
// whole Settings page. Skipped, not failed, where no browser is installed (same pattern as merge-queue-held-render.test.tsx).

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number } }) => Promise<Page>; close: () => Promise<void> };

async function launch(): Promise<Browser | null> {
  let chromium: { launch: (opts?: { executablePath?: string; args?: string[] }) => Promise<Browser> };
  try {
    chromium = createRequire(import.meta.url)("playwright").chromium;
  } catch {
    return null;
  }
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
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
const NEW = "202611241722";
const OLD = "202611241201";
const row = (slug: string, imageVersion: string) => ({ slug, name: `Company ${slug}`, registered: true, connected: true, at: new Date(Date.now() - 60_000).toISOString(), imageVersion, fault: null }) as unknown as LiveRow;
const hist = { id: "h1", target: "runner", commit: "abc", changes: 0, result: "deployed", message: null, at: new Date().toISOString() } as HistoryRow;
const maint = { on: true, kind: "update", deadline: new Date(Date.now() + 300_000).toISOString(), runs: 1, companies: 1 } as unknown as MaintenanceView;

const states: { name: string; live: LiveRow[]; badge: string; waiting: number }[] = [
  { name: "none-swapped", live: [row("a", OLD), row("b", OLD), row("c", OLD)], badge: "Swapping (0 of 3 companies done)", waiting: 3 },
  { name: "one-swapped", live: [row("a", NEW), row("b", OLD), row("c", OLD)], badge: "Swapping (1 of 3 companies done)", waiting: 2 },
  { name: "all-swapped", live: [row("a", NEW), row("b", NEW), row("c", NEW)], badge: "Swapping (3 of 3 companies done)", waiting: 0 },
];

const pageHtml = (live: LiveRow[]) => {
  const p = runnerProgress(live, maint, NEW);
  const tag = historyTag(hist, p);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="main"><section class="panel"><h3>Recent updates</h3><p><span class="tag ${tag.tone}">${tag.tag}</span> Runners, all companies</p><h3>Now running</h3><ul>${live.map((l) => renderToStaticMarkup(<LiveState r={l} progress={p} />)).join("")}</ul></section></main></body></html>`;
};

const read = () => ({
  badge: document.querySelector("p .tag")?.textContent ?? "",
  waiting: Array.from(document.querySelectorAll("ul .tag")).filter((t) => t.textContent === "Waiting for runs to finish").length,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
});

describe.skipIf(!browser)("Updates swap badge measures against the update's image (BOS-2546)", () => {
  for (const w of [{ name: "brave-1667", width: 1667, height: 724 }, { name: "safari-1550", width: 1550, height: 1611 }, { name: "phone-390", width: 390, height: 844 }]) {
    for (const s of states) {
      it(`${w.name} ${s.name}: badge and list agree, no sideways scroll`, async () => {
        const page = await browser!.newPage({ viewport: { width: w.width, height: w.height } });
        try {
          await page.setContent(pageHtml(s.live), { waitUntil: "load" });
          const got = await page.evaluate(read);
          expect(got.badge).toBe(s.badge);
          expect(got.waiting).toBe(s.waiting);
          expect(got.overflow).toBeLessThanOrEqual(0);
          if (out) {
            mkdirSync(out, { recursive: true });
            await page.screenshot({ path: path.join(out, `bos-2546-${w.name}-${s.name}.png`), fullPage: true });
          }
        } finally {
          await page.close();
        }
      });
    }
  }
});
