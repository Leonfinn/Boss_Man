import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";

// BOS-2742: a card option that promises a screenshot ("Done, screenshot of the result attached") now has a box under the
// answers to paste the picture in and an Attach file button. This renders the real Decisions page with the real
// styles.css in a headless browser at the owner's two devices (Safari 1550 wide, the Brave foldable 1667×724) and a
// 390 px phone, for an agent's card and a Boss Man to-do (with its "What went wrong" box), and checks the box, its
// label and the Attach file button are on screen, inside the card, don't overlap each other or the answer buttons,
// and nothing makes the page scroll sideways.
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

// Opt-in proof: with BOSSMAN_SCRATCH set, a full-page screenshot per device and card. Never a repo file.
const scratch = process.env.BOSSMAN_SCRATCH;
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `decisions-attach-${name}.png`) : null);

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const base: Decision = {
  id: "d1",
  companyId: "c1",
  kind: "question",
  question: "Run Google's live test on the sitemap and tell me what it says.",
  options: ["Done, screenshot of the result attached", "It failed"],
  recommendedOption: "Done, screenshot of the result attached",
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
const cards: Record<string, Decision> = {
  agent: base,
  todo: { ...base, question: "Add a collaborator on GitHub.", options: ["Done", "My screen looks different (I'll attach a screenshot)", "A step failed"], recommendedOption: "Done", context: { type: "owner_todo", steps: ["On GitHub, open the repo's page and click Settings."], attachOptions: ["My screen looks different (I'll attach a screenshot)"] } },
};

const html = (d: Decision) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={() => undefined} />)}</main></body></html>`;

/** The attach area's boxes, read from the rendered page. */
const read = () => {
  const field = document.querySelector('[data-testid="card-attach"]') as HTMLElement | null;
  if (!field) return null;
  const box = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const answers = [...document.querySelectorAll('[role="group"][data-shortcut-open] button')].map(box);
  const attach = [...field.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Attach file") ?? null;
  return {
    label: (field.querySelector("label") as HTMLElement | null)?.innerText ?? "",
    field: box(field),
    labelBox: box(field.querySelector("label")),
    textarea: box(field.querySelector("textarea")),
    attach: box(attach),
    answers,
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

describe.skipIf(!browser)("the screenshot box on a card in a real browser (BOS-2742)", () => {
  for (const d of devices) {
    for (const [kind, card] of Object.entries(cards)) {
      it(`${d.name}, ${kind} card: the paste box and Attach file sit under the answers, inside the card, overlapping nothing`, async () => {
        const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
        try {
          await page.setContent(html(card), { waitUntil: "load" });
          const got = await page.evaluate(read);
          expect(got).not.toBeNull();
          const g = got!;
          expect(g.label).toMatch(/Screenshot for ".+": paste it here or use Attach file\./);
          if (kind === "todo") expect(g.label).toMatch(/^What went wrong \(if a step failed\)/);
          const [textarea, attach, labelBox] = [g.textarea!, g.attach!, g.labelBox!];
          expect(textarea.width).toBeGreaterThan(200);
          expect(attach.width).toBeGreaterThan(0);
          // Label, then box, then button, top to bottom, none on top of another.
          expect(labelBox.bottom).toBeLessThanOrEqual(textarea.top + 0.5);
          expect(textarea.bottom).toBeLessThanOrEqual(attach.top + 0.5);
          // Every answer button is above the box and clear of it and of Attach file.
          expect(g.answers.length).toBe(card.options.length);
          for (const a of g.answers) {
            expect(a!.bottom).toBeLessThanOrEqual(textarea.top + 0.5);
            expect(overlaps(a!, attach)).toBe(false);
          }
          // Inside the card's field, and the page doesn't scroll sideways.
          for (const b of [textarea, attach, labelBox]) {
            expect(b.left).toBeGreaterThanOrEqual(g.field!.left - 0.5);
            expect(b.right).toBeLessThanOrEqual(g.field!.right + 0.5);
          }
          expect(g.fieldOverflow).toBeLessThanOrEqual(1);
          expect(g.pageOverflow).toBeLessThanOrEqual(1);
          const path = await shotPath(`${d.name}-${kind}`);
          if (path) await page.screenshot({ path, fullPage: true });
        } finally {
          await page.close();
        }
      });
    }
  }
});
