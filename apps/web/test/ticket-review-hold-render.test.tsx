import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { ReviewHold } from "../src/api";
import { ReviewHeldNote, ReviewHoldBanner } from "../src/components/ReviewHold";
import { holdWords } from "../src/hold-words";
import { Fold } from "../src/pages/Ticket";

// BOS-2870: BOS-2713's page showed the owner "Review: waiting for you" with Approve and merge while the CEO's hold
// was the only thing in its way and the owner's sign-off wasn't needed. The ticket page now names who holds it and
// until what, and once that is done, who has to release it and for how long it has waited. This renders the real
// banner and the Review box (the page's own Fold) with the real styles.css in a headless browser at 1440 and 390 wide
// and the owner's two devices, and checks the words, that the owner isn't told it's their turn, and that nothing
// runs off the card. Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

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

const scratch = process.env.BOSSMAN_SCRATCH;
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `ticket-review-hold-${name}.png`) : null);

const NOW = Date.parse("2026-11-27T16:20:00Z");
const base: ReviewHold = {
  id: "h1",
  system: false,
  reason: "Merges as the install step once BOS-2663 is in.",
  reviewer: "CEO",
  releaseAt: null,
  ready: false,
  readySince: null,
  label: "waits on BOS-2663",
  waits: [{ kind: "ticket", id: "t-2663", label: "BOS-2663", closed: false }],
};
const waiting: ReviewHold = { ...base, ready: true, readySince: new Date(NOW - 22 * 3_600_000).toISOString(), label: "ready to re-check", waits: [{ ...base.waits[0]!, closed: true }] };

/** The banner and the Review box as the page lays them out for a held ticket whose sign-off isn't needed. */
const block = (hold: ReviewHold) => (
  <section data-state={hold.ready ? "ready" : "held"}>
    <ReviewHoldBanner hold={hold} now={NOW} onRelease={() => undefined} onCancel={() => undefined} />
    <Fold className="review-card" title="Review" hint={holdWords(hold, NOW).hint} open>
      <ReviewHeldNote hold={hold} now={NOW} />
    </Fold>
  </section>
);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(
  <>
    {block(base)}
    {block(waiting)}
  </>,
)}</main></body></html>`;

const read = () =>
  [...document.querySelectorAll("section[data-state]")].map((s) => {
    const el = s as HTMLElement;
    const banner = el.querySelector("[data-testid=review-hold]") as HTMLElement;
    const fold = el.querySelector("details.review-card") as HTMLElement;
    const box = banner.getBoundingClientRect();
    const buttons = [...banner.querySelectorAll("button")].map((b) => {
      const r = b.getBoundingClientRect();
      return { text: (b as HTMLElement).innerText, visible: r.width > 0 && r.height > 0, inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 };
    });
    return {
      state: el.getAttribute("data-state"),
      headline: (el.querySelector("[data-testid=hold-headline]") as HTMLElement).innerText,
      hint: (fold.querySelector("summary small") as HTMLElement | null)?.innerText ?? "",
      body: (fold.querySelector("[data-testid=review-held]") as HTMLElement).innerText,
      foldText: fold.innerText,
      buttons,
      bannerOverflow: banner.scrollWidth - banner.clientWidth,
      foldOverflow: fold.scrollWidth - fold.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

const devices = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
];

describe("hold words (BOS-2870)", () => {
  it("names the holder and the wait, then who must release it and for how long", () => {
    expect(holdWords(base, NOW).headline).toBe("Held by CEO until BOS-2663 merges.");
    expect(holdWords(waiting, NOW).headline).toBe("Waiting for CEO to release it (22 h so far). What it waited for is done.");
    expect(holdWords({ ...base, releaseAt: "2026-11-30T00:00:00Z" }, NOW).headline).toBe("Held by CEO until BOS-2663 merges, or 30 Nov.");
    expect(holdWords({ ...waiting, system: true }, NOW).headline).toMatch(/Boss Man releases it by itself/);
  });
});

describe.skipIf(!browser)("a held ticket's page in a real browser (BOS-2870)", () => {
  for (const d of devices) {
    it(`${d.name}: says who holds it and never that it waits for the owner`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got.map((g) => g.state)).toEqual(["held", "ready"]);
        const [held, ready] = got as [(typeof got)[0], (typeof got)[0]];
        expect(held.headline).toBe("Held by CEO until BOS-2663 merges.");
        expect(held.hint).toBe("held by CEO until BOS-2663 merges");
        expect(ready.headline).toContain("Waiting for CEO to release it (22 h so far)");
        expect(ready.hint).toBe("waiting for CEO to release it (22 h so far)");
        for (const g of got) {
          expect(g.foldText).not.toMatch(/waiting for you/i);
          expect(g.foldText).not.toMatch(/Approve and merge/);
          expect(g.body).toMatch(/you don't need to do anything/);
          expect(g.buttons.map((b) => b.text)).toEqual(["Release hold", "Cancel hold and review again"]);
          for (const b of g.buttons) expect(b).toMatchObject({ visible: true, inside: true });
          expect(g.bannerOverflow).toBeLessThanOrEqual(1);
          expect(g.foldOverflow).toBeLessThanOrEqual(1);
          expect(g.pageOverflow).toBeLessThanOrEqual(1);
        }
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
