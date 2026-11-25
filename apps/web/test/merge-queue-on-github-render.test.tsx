import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { Waiting } from "../src/pages/MergeQueue";

// BOS-2605 (F2): a merge waiting on GitHub CI for its merge copy shows a blue "On GitHub" tag, not the grey "Waiting" tag of a
// ticket queued for a slot, and its head reads "on GitHub N min", not "waiting N min". Renders the real Waiting component with
// the real styles.css in a headless browser at the owner's devices and a 380 px phone, beside a plain waiting row for contrast.
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg?: A) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
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

// Opt-in proof: with BOSSMAN_SCRATCH set, a full-page screenshot per device. Never a repo file.
const scratch = process.env.BOSSMAN_SCRATCH;
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `merge-queue-on-github-${name}.png`) : null);

const base = { stuck: false, risk: "medium", urgent: false, failedCheck: false, actor: "system" as const, decisionId: null };
const rows = [
  {
    ...base,
    ticketId: "t1",
    ref: "BOS-2601",
    title: "Release workflow change",
    minutes: 31,
    state: "waiting_for_ci" as const,
    label: "waiting for GitHub CI on its merge copy (check), 31 min so far (workflow change: GitHub runs every job, usually longer)",
    next: "It merges by itself once GitHub CI passes.",
  },
  {
    ...base,
    ticketId: "t2",
    ref: "BOS-2602",
    title: "Next in line for a slot",
    minutes: 4,
    state: "waiting_for_slot" as const,
    label: "next in line for a check",
    next: "It starts when a slot is free.",
  },
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(<Waiting rows={rows} />)}</main></body></html>`;

const read = () =>
  [...document.querySelectorAll("article.mq-item")].map((a) => {
    const el = a as HTMLElement;
    const tag = el.querySelector(".mq-line .tag") as HTMLElement | null;
    const wait = el.querySelector(".mq-wait") as HTMLElement | null;
    const box = el.getBoundingClientRect();
    const tagBox = tag?.getBoundingClientRect();
    return {
      word: el.getAttribute("data-state-word"),
      tagText: tag?.innerText ?? null,
      tagClass: tag?.className ?? null,
      tagColor: tag ? getComputedStyle(tag).color : null,
      wait: wait?.innerText ?? null,
      text: el.innerText,
      inside: !tagBox || (tagBox.left >= box.left - 0.5 && tagBox.right <= box.right + 0.5),
      overflow: el.scrollWidth - el.clientWidth,
    };
  });

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-380", viewport: { width: 380, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("merge queue: a merge waiting on GitHub CI (BOS-2605)", () => {
  for (const d of devices) {
    it(`${d.name}: blue "On GitHub" tag, "on GitHub N min", contrast with a grey Waiting row, nothing overflows`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got).toHaveLength(2);
        const [ci, slot] = got as [(typeof got)[0], (typeof got)[0]];

        expect(ci.word).toBe("On GitHub");
        expect(ci.tagText).toBe("On GitHub");
        expect(ci.tagClass).toContain("blue");
        expect(ci.wait).toBe("on GitHub 31m");
        expect(ci.text).toContain("workflow change: GitHub runs every job");
        expect(ci.text).not.toMatch(/waiting 31m/);

        expect(slot.word).toBe("Waiting");
        expect(slot.tagClass).toContain("grey");
        expect(slot.wait).toBe("waiting 4m");
        // The tag colour differs: the two rows can't be told apart by words alone otherwise.
        expect(ci.tagColor).not.toBe(slot.tagColor);

        for (const row of got) {
          expect(row.inside).toBe(true);
          expect(row.overflow).toBeLessThanOrEqual(1);
        }
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
