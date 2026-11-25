import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { TrialLines } from "../src/pages/settings/System";

// BOS-2562: while a failed update is held (BOS-2554, failureHolds from GET /api/self-deploy), the Updates status box says so in
// the server's own words. This renders TrialLines (where the line lives) inside the status box with the real styles.css in headless
// Chromium at the owner's two desktop widths and a 380 px phone, and checks that the line shows only while a hold exists, wraps
// inside the box and causes no sideways scroll. It renders that component by hand, not the whole Settings page. Skipped, not failed,
// where no browser is installed (same pattern as updates-swap-badge-render.test.tsx).

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
const WORDS = "Held: the last update failed, being looked into. No new Deploy card is offered until the logs you were asked for are in, or until 26 Nov 06:00. (Update abc12345 failed.)";
const states: { name: string; holds: { subject: string; words: string }[]; lines: number }[] = [
  { name: "no-hold", holds: [], lines: 0 },
  { name: "held", holds: [{ subject: "server_deploy", words: WORDS }], lines: 1 },
  { name: "both-held", holds: [{ subject: "server_deploy", words: WORDS }, { subject: "runner_update", words: WORDS.replace("Deploy card", "runner update card") }], lines: 2 },
];

const pageHtml = (holds: { subject: string; words: string }[]) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="main"><section class="panel"><h3>Updates</h3><div class="upd-status bad"><span class="tag bad">Failed</span><div class="upd-status-body"><p class="upd-say">The last update did not go through.</p>${renderToStaticMarkup(<TrialLines now={Date.now()} failureHolds={holds} />)}</div></div></section></main></body></html>`;

const read = () => {
  const box = document.querySelector(".upd-status")!.getBoundingClientRect();
  const lines = Array.from(document.querySelectorAll('[data-testid="failure-hold"]'));
  return {
    count: lines.length,
    text: lines.map((l) => l.textContent ?? ""),
    insideBox: lines.every((l) => { const r = l.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; }),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

describe.skipIf(!browser)("Updates status box shows the failure hold's words (BOS-2562)", () => {
  for (const w of [{ name: "brave-1667", width: 1667, height: 724 }, { name: "safari-1550", width: 1550, height: 1611 }, { name: "phone-380", width: 380, height: 844 }]) {
    for (const s of states) {
      it(`${w.name} ${s.name}: ${s.lines} hold line(s), inside the box, no sideways scroll`, async () => {
        const page = await browser!.newPage({ viewport: { width: w.width, height: w.height } });
        try {
          await page.setContent(pageHtml(s.holds), { waitUntil: "load" });
          const got = await page.evaluate(read);
          expect(got.count).toBe(s.lines);
          expect(got.text).toEqual(s.holds.map((h) => h.words));
          expect(got.insideBox).toBe(true);
          expect(got.overflow).toBeLessThanOrEqual(0);
          if (out) {
            mkdirSync(out, { recursive: true });
            await page.screenshot({ path: path.join(out, `bos-2562-${w.name}-${s.name}.png`), fullPage: true });
          }
        } finally {
          await page.close();
        }
      });
    }
  }
});
