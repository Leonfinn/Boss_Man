import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { Recent } from "../src/pages/MergeQueue";

// BOS-1938: a finished check's stage line on the Merge queue's "Recently finished" rows. The server writes
// the line (see apps/server/test/check-stage-line.test.ts); this checks the page shows it when there is one,
// shows nothing extra when there is none (a job from before BOS-1923), and that it wraps at phone width.

const FULL = "Full check, 28 min: server tests 16 min · shell tests 6 min · web tests 3 min · other 3 min. 2 of 3 slots busy when it started.";
const QUICK = "Quick check, 4 min: typecheck 2 min · related tests 1 min · lint 1 min. 0 of 3 slots busy when it started.";
const at = new Date().toISOString();
const row = (n: number, stageLine?: string) => ({ ticketId: `t${n}`, ref: `BOS-${n}`, title: `Ticket ${n}`, result: "merged" as const, detail: "merged", at, stageLine });
const rows = [row(1, FULL), row(2, QUICK), row(3)];

const markup = renderToStaticMarkup(<Recent rows={rows} />);

describe("Recently finished rows: stage line", () => {
  it("shows the full check line with total, three stages, other, and the busy slots", () => {
    expect(markup).toContain(FULL);
  });
  it("labels a quick check as Quick check", () => {
    expect(markup).toContain("Quick check, 4 min");
    expect(markup.match(/Full check/g)).toHaveLength(1);
  });
  it("shows no stage line and no 0 min for a job with no step record", () => {
    const html = renderToStaticMarkup(<Recent rows={[row(3)]} />);
    expect(html).not.toContain("data-stage-line");
    expect(html).not.toContain("0 min");
  });
});

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number }; isMobile?: boolean }) => Promise<Page>; close: () => Promise<void> };

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

describe.skipIf(!browser)("stage line at phone width (BOS-1938)", () => {
  it("390 px: the line wraps onto more than one line and the page does not scroll sideways", async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    try {
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main class="main">${markup}</main></body></html>`, { waitUntil: "load" });
      const got = await page.evaluate(() => {
        const el = document.querySelector("[data-stage-line]") as HTMLElement;
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
        return { lines: Math.round(el.getBoundingClientRect().height / lh), pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      expect(got.lines).toBeGreaterThan(1);
      expect(got.pageOverflow).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });
});
