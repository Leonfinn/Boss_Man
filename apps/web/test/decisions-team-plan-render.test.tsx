// A rendering check of the team-plan card (BOS-2824). The card used to list every hire twice: once with
// its harness, provider, model and paid-from, and again as a tick box with a template id. Each hire is
// now one row (name, role, what they will do), the model setup sits inside a closed "Technical details",
// and the hire button counts the ticks. This renders the real Decisions page with the real styles.css in
// a headless browser at the two devices the devices tool reports (Safari 1550, the Brave foldable
// 1667×724) and a 390 px phone, with a long name and eight hires, and measures the boxes: rows stay
// inside the card, nothing scrolls sideways, the cost line is on one line at desktop widths, and the
// closed fold adds no height.
//
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";

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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `team-plan-card-${name}.png`) : null);

// The app's own page class, so the card sits in the width it really gets.

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

const longName = "Alexandra-Felicity Montgomery-Worthington";
const hires = Array.from({ length: 8 }, (_, i) => ({
  name: i === 0 ? longName : `Hire ${i + 1}`,
  title: "Customer Support Lead",
  template: "support",
  harness: "claude",
  provider: "anthropic",
  model: "claude-sonnet-4-5-20250929",
  fundingSourceName: "Claude Max 20x plan",
  fundingSourceKind: "subscription",
  reason: "Answers customers, sorts feedback into the right tickets, and keeps the wiki ready with the answers people ask for most often.",
  skills: ["triage", "wiki-writing"],
}));

const plan: Decision = {
  id: "d1",
  companyId: "c1",
  kind: "approval",
  question: `Hire ${hires.length} agents for App Co?\n\nAlready covered: the CEO runs the work.\n\nOn your Claude Max 20x plan: no extra cost`,
  options: ["Hire the ticked ones", "Not now"],
  recommendedOption: "Hire the ticked ones",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "CEO",
  blocks: [],
  score: 10,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  context: { type: "team_plan", covered: "the CEO runs the work.", costLine: "On your Claude Max 20x plan: no extra cost", hires },
};

/** What the owner sees in the card, measured from the rendered page. */
const read = (name: string) => {
  const card = document.querySelector("li.decision") as HTMLElement | null;
  if (!card) return null;
  const box = card.getBoundingClientRect();
  const body = card.querySelector(".body") as HTMLElement | null;
  const bodyBox = body?.getBoundingClientRect() ?? box;
  const rows = [...card.querySelectorAll("fieldset label")] as HTMLElement[];
  const details = card.querySelector("details") as HTMLElement | null;
  const summary = details?.querySelector("summary") as HTMLElement | null;
  const cost = [...card.querySelectorAll("p")].find((p) => /no extra cost|pay as you go/i.test(p.textContent ?? "")) as HTMLElement | null;
  const button = [...card.querySelectorAll("button")].find((b) => /^Hire the \d+ ticked/.test((b.textContent ?? "").trim())) as HTMLElement | null;
  // Everything the card shows sits inside its body's box (the border and padding are outside that).
  const inside = (r: DOMRect) => r.left >= bodyBox.left - 0.5 && r.right <= bodyBox.right + 0.5;
  return {
    name,
    rows: rows.length,
    rowInside: rows.every((r) => inside(r.getBoundingClientRect())),
    rowOverflow: rows.map((r) => r.scrollWidth - r.clientWidth),
    rowWidth: rows.map((r) => r.getBoundingClientRect().width),
    // A row with a long name and a long reason still wraps rather than widening: the card is as wide as its box.
    cardInside: inside(bodyBox),
    oneRowEach: rows.every((r) => (r.querySelectorAll("strong").length === 1)),
    foldClosed: !!details && !(details as HTMLDetailsElement).open,
    foldMarked: summary?.textContent?.trim() === "Technical details",
    // A closed fold is just its summary line: it keeps the model setup out of the way until opened.
    foldHeight: details?.getBoundingClientRect().height ?? 0,
    summaryHeight: summary?.getBoundingClientRect().height ?? 0,
    costText: cost?.textContent?.trim() ?? null,
    costLines: cost ? Math.round(cost.getBoundingClientRect().height / parseFloat(getComputedStyle(cost).lineHeight || "20")) : 0,
    buttonText: button?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    buttonInside: !!button && inside(button.getBoundingClientRect()),
    overflow: card.scrollWidth - card.clientWidth,
  };
};

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

const { renderToStaticMarkup } = await import("react-dom/server");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(
  <Decisions decisions={[plan]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} />,
)}</main></body></html>`;

describe.skipIf(!browser)("team-plan card in a real browser (BOS-2824)", () => {
  for (const d of devices) {
    it(`${d.name}: one row per hire, a closed Technical details, a counting button, nothing off the card`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read, d.name);
        expect(got).not.toBeNull();
        const g = got!;
        expect(g.rows).toBe(8);
        expect(g.oneRowEach).toBe(true);
        expect(g.rowInside).toBe(true);
        expect(g.cardInside).toBe(true);
        expect(g.buttonInside).toBe(true);
        expect(g.overflow).toBeLessThanOrEqual(1);
        for (const w of g.rowOverflow) expect(w).toBeLessThanOrEqual(1);
        // The technical details are folded, so they add no height until opened, and say what they are.
        expect(g.foldClosed).toBe(true);
        expect(g.foldMarked).toBe(true);
        expect(g.foldHeight - g.summaryHeight).toBeLessThan(4);
        // The cost line is plain words from the funding kind, and the button counts every hire to start.
        expect(g.costText).toBe("On your Claude Max 20x plan: no extra cost");
        if (d.name !== "phone-390") expect(g.costLines).toBe(1);
        expect(g.buttonText).toContain("Hire the 8 ticked");
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
