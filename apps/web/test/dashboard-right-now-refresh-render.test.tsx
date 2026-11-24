import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { RightNow, healthLines } from "../src/components/DashboardPanels";

// BOS-2538: the "Right now" heading said "Refreshes every 10 s" over four lines, but the Merges line comes from the
// merge-queue poll every 20 s. Each line now states its own interval under it and the heading states none. The tests
// render the real RightNow component (and styles.css) to markup and read it in headless Chromium — a full-app mount
// would need the Dashboard's own poll data, and this doesn't change that — at the owner's two screens (Brave 1667×724
// touch, Safari 1550×1611) and a 390 px phone. On the phone the lines are a 2x2 pill grid with no room for a note, so
// there the heading names that the lines hold their own intervals and the notes stay off screen. Everywhere else the
// notes are visible, each inside its own row, and the heading names no single interval. With BOSSMAN_SCRATCH set it
// saves a shot per device. Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean; isMobile?: boolean }) => Promise<Page>;
  close: () => Promise<void>;
};

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
const ok = { runner: { registered: true, connected: true, lastSeenAt: null }, usage: { agents: 0, accounts: [], firstResetAt: null }, update: { waiting: false, phase: null, deadline: null } };
const lines = healthLines({ health: ok, merges: { waitingCount: 0, lineCount: 0, stuckCount: 0, line: { state: "healthy" } } as never, stuck: null, running: 0, companyId: "c1" });
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(<RightNow lines={lines} paused={false} companyId="c1" />)}</main></body></html>`;

const read = () => {
  const panel = document.querySelector(".dash-right")!;
  const head = panel.querySelector("#dash-right")!;
  const small = head.querySelector("small")!;
  return {
    heading: head.textContent ?? "",
    note: small.textContent ?? "",
    noteBox: small.getBoundingClientRect().toJSON() as { width: number; height: number },
    panelBox: panel.getBoundingClientRect().toJSON() as { left: number; right: number },
    lines: Array.from(panel.querySelectorAll(".dash-line")).map((l) => {
      const refresh = l.querySelector(".dash-refresh") as HTMLElement | null;
      const row = l.getBoundingClientRect();
      const note = refresh!.getBoundingClientRect();
      return {
        refresh: refresh?.textContent ?? null,
        noteVisible: !!refresh && note.width > 0 && note.height > 0,
        insideRow: !!refresh && note.left >= row.left - 0.5 && note.right <= row.right + 0.5,
        rowOverflow: (l as HTMLElement).scrollWidth - (l as HTMLElement).clientWidth,
      };
    }),
  };
};

const devices = [
  { name: "brave-1667x724", width: 1667, height: 724, ratio: 3, touch: true, phone: false },
  { name: "safari-1550x1611", width: 1550, height: 1611, ratio: 2, touch: false, phone: false },
  { name: "phone-390", width: 390, height: 844, ratio: 2, touch: true, phone: true },
];

describe.skipIf(!browser)("Dashboard Right now freshness wording in a real browser (BOS-2538)", () => {
  for (const d of devices) {
    it(`${d.name}: each line names its own interval (Merges 20 s, the rest 10 s) and the heading names no single one`, async () => {
      const page = await browser!.newPage({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.ratio, hasTouch: d.touch, isMobile: d.touch });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got.lines).toHaveLength(4);
        expect(got.lines.map((l) => l.refresh)).toEqual(["Updates every 10 s.", "Updates every 20 s.", "Updates every 10 s.", "Updates every 10 s."]);
        expect(got.heading).not.toMatch(/every 10 s/);
        expect(got.heading).not.toMatch(/every 20 s/);
        // The heading still says something about the intervals, never a bare panel title.
        expect(got.heading.replace("Right now", "").trim()).not.toBe("");
        // Nothing runs sideways out of its row or its panel.
        expect(got.lines.every((l) => l.rowOverflow <= 0)).toBe(true);
        expect(got.noteBox.width).toBeLessThanOrEqual(d.width);
        if (d.phone) {
          // The 2x2 pill grid has no room for a note: the heading carries the promise, the notes stay off screen.
          expect(got.lines.every((l) => !l.noteVisible)).toBe(true);
          expect(got.note).toMatch(/each line/i);
        } else {
          // Each note is visible, inside its own row, beside the heading note.
          expect(got.lines.every((l) => l.noteVisible && l.insideRow)).toBe(true);
          expect(got.noteBox.height).toBeGreaterThan(0);
        }
        if (out) {
          mkdirSync(out, { recursive: true });
          await page.screenshot({ path: path.join(out, `bos-2538-right-now-${d.name}.png`), fullPage: true });
        }
      } finally {
        await page.close();
      }
    });
  }
});
