import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { MilestoneLeft, leftFacts, type MilestoneTicketRow } from "../src/pages/MilestoneLeft";

// BOS-2580: a milestone's "What's left" list, rendered with the real styles.css in a headless browser at the owner's two
// devices and a phone width. Every group is seeded (made-up tickets): Waiting for you with its Open card button, Held up,
// Needs a look, Running, and a folded Being built. It checks the order of the groups, the card link, the button's height on
// a phone, and that nothing runs off the side. Skipped, not failed, where no browser is installed.

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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `milestone-left-${name}.png`) : null);

const TODAY = "2026-11-25";
const CARD = "aaaaaaaa-1111-4111-8111-111111111111";
const row = (n: number, title: string, extra: Partial<MilestoneTicketRow>): MilestoneTicketRow => ({ id: `t${n}`, ref: `BOS-${900 + n}`, title, state: "blocked", outcome: null, assignee: "Kit", ...extra });
const rows: MilestoneTicketRow[] = [
  row(1, "Pick the release provider for the installer", { group: "owner", waits: [{ kind: "card", text: "your card", id: CARD }], cardId: CARD, updatedDaysAgo: 2 }),
  row(2, "Rotate the demo key after the move", { group: "held", waits: [{ kind: "ticket", text: "BOS-905", id: "t5" }], updatedDaysAgo: 1 }),
  row(3, "Wait for the vendor to confirm the account", { group: "held", waits: [{ kind: "note", text: "no link recorded; see its note" }], updatedDaysAgo: 6 }),
  row(4, "A red run on main opens a ticket, with a very long title that has to wrap onto more than one line on a phone", { group: "look", watchUntil: "2026-11-25", quietDays: 0, updatedDaysAgo: 7 }),
  row(5, "7 days with no re-run card", { group: "running", watchUntil: "2026-11-26", updatedDaysAgo: 0 }),
  row(6, "A week of landing figures", { group: "running", watchUntil: "2026-12-01", updatedDaysAgo: 0 }),
  row(7, "Stay in step with the server", { group: "building", state: "in_progress", updatedDaysAgo: 0 }),
  row(8, "Finished work", { group: null, state: "done" }),
];
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main class="main"><div class="rm-detail">${renderToStaticMarkup(<MilestoneLeft rows={rows} today={TODAY} />)}</div></main></body></html>`;

const read = () => {
  const groups = [...document.querySelectorAll(".rm-left-group[data-group]")].map((g) => g.getAttribute("data-group"));
  const btn = document.querySelector(".rm-left-card") as HTMLAnchorElement | null;
  const box = btn?.getBoundingClientRect();
  const folded = [...document.querySelectorAll("details[data-group]")].map((d) => `${d.getAttribute("data-group")}:${(d as HTMLDetailsElement).open}`);
  return {
    groups,
    folded,
    href: btn?.getAttribute("href") ?? null,
    btnHeight: box?.height ?? 0,
    btnWidth: box?.width ?? 0,
    parentWidth: (btn?.parentElement as HTMLElement | null)?.getBoundingClientRect().width ?? 0,
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    text: document.body.innerText,
  };
};

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2, phone: false },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true, phone: false },
  { name: "half-screen-724", viewport: { width: 724, height: 900 }, deviceScaleFactor: 2, phone: false },
  { name: "phone-380", viewport: { width: 380, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, phone: true },
];

describe("leftFacts", () => {
  it("words each wait and watch date from the ticket's facts", () => {
    expect(leftFacts(rows[0]!, TODAY)).toEqual(["waits on your card", "no update for 2 days"]);
    expect(leftFacts(rows[1]!, TODAY)).toEqual(["waits on BOS-905", "no update for 1 day"]);
    expect(leftFacts(rows[3]!, TODAY)).toEqual(["ends today", "no update for 7 days"]);
    expect(leftFacts(rows[4]!, TODAY)).toEqual(["ends tomorrow, Thu 26 Nov", "updated today"]);
    expect(leftFacts({ ...rows[3]!, watchUntil: "2026-11-20" }, TODAY)[0]).toBe("date passed 5 days ago");
  });
});

describe.skipIf(!browser)("milestone What's left in a real browser (BOS-2580)", () => {
  for (const d of devices) {
    it(`${d.name}: groups in order, Open card links to the card, Being built folded, nothing off the side`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got.groups).toEqual(["owner", "held", "look", "running", "building"]);
        expect(got.folded).toEqual(["building:false"]);
        expect(got.href).toBe(`#/decisions/${CARD}`);
        expect(got.text).toContain("What's left: 7 tickets not done");
        expect(got.text).toContain("Finished (1)");
        expect(got.page).toBeLessThanOrEqual(1);
        if (d.phone) {
          // Full width under its ticket and at least 44 px tall to tap.
          expect(got.btnHeight).toBeGreaterThanOrEqual(44);
          expect(Math.abs(got.btnWidth - got.parentWidth)).toBeLessThanOrEqual(1);
        }
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
