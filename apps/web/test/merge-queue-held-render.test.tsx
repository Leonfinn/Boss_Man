import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { Waiting } from "../src/pages/MergeQueue";

// A rendering check of the Merge queue's held rows (BOS-1078). The owner saw BOS-979 and BOS-972 as
// "WAITING FOR A DECISION … Needs you: open the card" after signing both off, and took it for a second
// sign-off. Each row now names the card that holds it, who raised it and links straight to it, and a
// signed-off one says so first. This renders the real Waiting component to markup with the real
// styles.css and reads it in a headless browser at the owner's two devices (Safari 1550 wide, the Brave
// foldable 1667×724) and a phone width, for the three held states: held by the sign-off, held by another
// card, and signed off but held by another card. It checks the words the owner reads are on screen,
// the link points at the card, and nothing runs off the row.
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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `merge-queue-held-${name}.png`) : null);

const SIGN_OFF_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const HOLD_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const SIGNED_HOLD_ID = "cccccccc-3333-4333-8333-333333333333";
const signedAt = new Date();
signedAt.setHours(12, 55, 0, 0);

const base = { minutes: 25, stuck: false, risk: "high", urgent: false, failedCheck: false, actor: "owner" as const };
const rows = [
  {
    ...base,
    ticketId: "t1",
    ref: "BOS-901",
    title: "Held by the sign-off",
    state: "waiting_for_sign_off" as const,
    label: "waiting for your sign-off",
    next: "Boss Man merges it as soon as you answer the sign-off.",
    decisionId: SIGN_OFF_ID,
    card: { id: SIGN_OFF_ID, kind: "sign_off" as const, question: "Merge it, or send it back?", raisedBy: null, raisedAt: signedAt.toISOString(), staleHint: null },
    signedOffAt: null,
  },
  {
    ...base,
    ticketId: "t2",
    ref: "BOS-902",
    title: "Held by another card",
    state: "waiting_for_decision" as const,
    label: `held by Kit's card: "Should the new judge run before the pack is rebuilt?"`,
    next: "it merges once that card is answered.",
    decisionId: HOLD_ID,
    card: { id: HOLD_ID, kind: "hold" as const, question: "Should the new judge run before the pack is rebuilt?", raisedBy: "Kit", raisedAt: signedAt.toISOString(), staleHint: null },
    signedOffAt: null,
  },
  {
    ...base,
    ticketId: "t3",
    ref: "BOS-903",
    title: "Signed off, held by another card",
    state: "waiting_for_decision" as const,
    label: `held by Jane's card: "Rotate the deploy key on the host before this merges, so the old key stops working at once?"`,
    next: "Your sign-off is done; it merges once that card is answered.",
    decisionId: SIGNED_HOLD_ID,
    card: { id: SIGNED_HOLD_ID, kind: "hold" as const, question: "Rotate the deploy key on the host before this merges, so the old key stops working at once?", raisedBy: "Jane", raisedAt: signedAt.toISOString(), staleHint: "It names BOS-1066, which is done now, so it may no longer be needed." },
    signedOffAt: signedAt.toISOString(),
  },
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(<Waiting rows={rows} />)}</main></body></html>`;

/** What the owner sees in each row, read from the rendered page. */
const read = () =>
  [...document.querySelectorAll("article.mq-item")].map((a) => {
    const el = a as HTMLElement;
    const held = el.querySelector("[data-held-by]") as HTMLElement | null;
    const link = held?.querySelector("a[data-card-link]") as HTMLAnchorElement | null;
    const r = held?.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return {
      text: el.innerText,
      heldBy: held?.getAttribute("data-held-by") ?? null,
      heldText: held?.innerText ?? null,
      href: link?.getAttribute("href") ?? null,
      linkVisible: !!link && link.getBoundingClientRect().width > 0 && link.getBoundingClientRect().height > 0,
      // The held line sits inside its row, and the row doesn't scroll sideways.
      inside: !r || (r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
      overflow: el.scrollWidth - el.clientWidth,
      stale: !!el.querySelector('[data-stale="true"]'),
    };
  });

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("merge queue held rows in a real browser (BOS-1078)", () => {
  for (const d of devices) {
    it(`${d.name}: each held row names its card and links to it; a signed-off one says so`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got).toHaveLength(3);
        const [sign, hold, signedHold] = got as [(typeof got)[0], (typeof got)[0], (typeof got)[0]];

        // 1. Held by the sign-off: it says it is the owner's sign-off, with a link to that card.
        expect(sign.heldBy).toBe("sign_off");
        expect(sign.heldText).toContain("Needs you: your sign-off on this work.");
        expect(sign.href).toBe(`#/decisions/${SIGN_OFF_ID}`);

        // 2. Held by another card: the card's question and who raised it, never "signed this off".
        expect(hold.heldBy).toBe("card");
        expect(hold.heldText).toMatch(/^Held by a card: .Should the new judge run before the pack is rebuilt\?., raised by Kit\./);
        expect(hold.text).not.toMatch(/signed this off/);
        expect(hold.href).toBe(`#/decisions/${HOLD_ID}`);

        // 3. Signed off, held by another card: the sign-off is named as done first, then the other card.
        expect(signedHold.heldBy).toBe("card");
        expect(signedHold.heldText).toMatch(/^You signed this off at 12.?55(\s?[AP]M)?\. It's held by a different card: /);
        expect(signedHold.heldText).toContain("raised by Jane");
        expect(signedHold.href).toBe(`#/decisions/${SIGNED_HOLD_ID}`);
        expect(signedHold.stale).toBe(true);
        expect(signedHold.heldText).toContain("The CEO has been asked to check it.");

        for (const row of got) {
          expect(row.text).not.toMatch(/you is acting/);
          expect(row.linkVisible).toBe(true);
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
