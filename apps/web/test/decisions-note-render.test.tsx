import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";

// BOS-2798: a card option that says its answer is in the note ("Done, output pasted in my note") now has the note box
// shown open under the answers, four rows tall for pasted output. This renders the real Decisions page with the real
// styles.css in a headless browser at the owner's two devices (Safari 1550 wide, the Brave foldable 1667×724) and a
// 390 px phone, and checks the label and box are on screen, inside the card, below the answer buttons and clear of
// them, taller than the two-row note, and that nothing makes the page scroll sideways.
//
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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `decisions-note-${name}.png`) : null);

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const card: Decision = {
  id: "d1",
  companyId: "c1",
  kind: "question",
  question: "Run df -h on the host and paste the output.",
  options: ["Done, output pasted in my note", "It failed"],
  recommendedOption: "Done, output pasted in my note",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "Engineer",
  blocks: [],
  score: 10,
  parts: { blocking: 0, urgency: 0, age: 10, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  context: { type: "question" },
};

const html = (d: Decision) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => undefined} />)}</main></body></html>`;

/** The note field's boxes, read from the rendered page. */
const read = () => {
  const field = document.querySelector('[data-testid="card-note"]') as HTMLElement | null;
  if (!field) return null;
  const box = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const textarea = field.querySelector("textarea");
  const line = textarea ? parseFloat(getComputedStyle(textarea).lineHeight) || 20 : 20;
  return {
    label: (field.querySelector("label") as HTMLElement | null)?.innerText ?? "",
    field: box(field),
    labelBox: box(field.querySelector("label")),
    textarea: box(textarea),
    line,
    answers: [...document.querySelectorAll('[role="group"][data-shortcut-open] button')].map(box),
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    fieldOverflow: field.scrollWidth - field.clientWidth,
  };
};

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("the note box for an 'in my note' option in a real browser (BOS-2798)", () => {
  for (const d of devices) {
    it(`${d.name}: the note box is open under the answers, inside the card, overlapping nothing`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html(card), { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got).not.toBeNull();
        const g = got!;
        expect(g.label).toMatch(/^Your note for "Done, output pasted in my note": paste the output or write your answer here, then press it\./);
        const [textarea, labelBox] = [g.textarea!, g.labelBox!];
        expect(textarea.width).toBeGreaterThan(200);
        // Four rows: room to see pasted output, more than three lines of text tall.
        expect(textarea.height).toBeGreaterThan(g.line * 3);
        expect(labelBox.bottom).toBeLessThanOrEqual(textarea.top + 0.5);
        expect(g.answers.length).toBe(card.options.length);
        for (const a of g.answers) {
          expect(a!.bottom).toBeLessThanOrEqual(labelBox.top + 0.5);
          expect(overlaps(a!, textarea)).toBe(false);
        }
        for (const b of [textarea, labelBox]) {
          expect(b.left).toBeGreaterThanOrEqual(g.field!.left - 0.5);
          expect(b.right).toBeLessThanOrEqual(g.field!.right + 0.5);
        }
        expect(g.fieldOverflow).toBeLessThanOrEqual(1);
        expect(g.pageOverflow).toBeLessThanOrEqual(1);
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
