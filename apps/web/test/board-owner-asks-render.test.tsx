import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { OwnerAsksLaneHead, OwnerAsksStrip, SameQuestionLine, sameQuestionAs, sameQuestionText } from "../src/components/OwnerAsks";

// BOS-2578: three tickets wait on ONE decision card, and a second card has no ticket. The board's banner
// and "Your review" lane must say "1 question, 3 tasks", and each sharing ticket must name the others.
// Rendered with the real styles.css in Chromium at 380, 724 and 1667 px. Skipped where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = { newPage: (opts?: { viewport?: { width: number; height: number } }) => Promise<Page>; close: () => Promise<void> };

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
const CARD = "88b936b3-0000-4000-8000-000000000001";
const mk = (id: string, number: number, title: string) => ({ id, number, title, ownerQuestionId: CARD });
const waiting = [mk("a", 974, "Cut the beta release notes"), mk("b", 1488, "Tag the beta build"), mk("c", 2271, "Publish the beta page")];
const ref = (n: number) => `BOS-${n}`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main class="main">${renderToStaticMarkup(
  <>
    <OwnerAsksStrip waiting={waiting} decisionsOpen={2} />
    <section className="lane mine">
      <OwnerAsksLaneHead waiting={waiting} decisionsOpen={2} />
      {waiting.map((t) => (
        <article className="ticket mine" key={t.id} data-ticket-id={t.id}>
          <h3>{t.title}</h3>
          <SameQuestionLine text={sameQuestionText(sameQuestionAs(t, waiting), ref)} />
        </article>
      ))}
    </section>
  </>,
)}</main></body></html>`;

const read = () => ({
  banner: (document.querySelector('[data-testid="owner-asks-words"]') as HTMLElement).innerText,
  badges: [...document.querySelectorAll(".count-badge")].map((b) => (b as HTMLElement).innerText),
  hint: (document.querySelector('[data-testid="owner-asks-lane-hint"]') as HTMLElement | null)?.innerText ?? null,
  notes: [...document.querySelectorAll('[data-testid="same-question-note"]')].map((n) => (n as HTMLElement).innerText),
  noTask: (document.querySelector('[data-testid="owner-asks-no-task"]') as HTMLElement | null)?.innerText ?? null,
  stripInside: (() => {
    const strip = document.querySelector("a.strip")!.getBoundingClientRect();
    const text = (document.querySelector('[data-testid="owner-asks-words"]') as HTMLElement).getBoundingClientRect();
    return text.left >= strip.left - 1 && text.right <= strip.right + 1;
  })(),
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
});

describe("same-question wording", () => {
  it("names the other tickets on the card", () => {
    expect(sameQuestionText(sameQuestionAs(waiting[0]!, waiting), ref)).toBe("Same question as BOS-1488 and BOS-2271: one answer releases all three.");
    expect(sameQuestionText([waiting[1]!], ref)).toBe("Same question as BOS-1488: one answer releases both.");
  });
});

describe.skipIf(!browser)("Board owner asks in a real browser (BOS-2578)", () => {
  for (const width of [380, 724, 1667]) {
    it(`${width}px: one question holding three tasks is said once, and each ticket names the others`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 900 } });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got.banner).toBe("1 question is waiting on you, holding 3 tasks.");
        expect(got.badges).toEqual(["1", "1"]);
        expect(got.hint).toContain("1 question holds 3 tasks");
        expect(got.hint).toContain("1 more question has no task: see Decisions.");
        expect(got.noTask?.trim()).toBe("1 more question has no task: see Decisions.");
        expect(got.stripInside).toBe(true);
        expect(got.notes).toHaveLength(3);
        expect(got.notes[0]).toBe("Same question as BOS-1488 and BOS-2271: one answer releases all three.");
        expect(got.overflow).toBeLessThanOrEqual(1);
        if (scratch) await page.screenshot({ path: `${scratch}/board-owner-asks-${width}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
