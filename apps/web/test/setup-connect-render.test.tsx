import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { CONNECT_OPTIONS } from "@boss-man/shared";
import type { Company } from "../src/api";
import { ConnectList } from "../src/pages/SetupClaude";

// BOS-2815: a rendering check of the setup wizard's connect step (BOS-2511). It draws the real ConnectList — every
// row of the one equal list, and one row open with its steps — with the real styles.css, in a headless browser at the
// widths the devices tool gives (Safari 1550, the Brave foldable 1667×724) and a 390 px phone. It measures geometry:
// every row is the same height and full width with a 44 px tap target on touch, an open row's steps stay inside the
// page, and no width scrolls sideways. The rows are CONNECT_OPTIONS, so a new provider is drawn without a change here.
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T, A>(fn: (arg: A) => T, arg: A) => Promise<T>;
  screenshot: (opts: { path: string }) => Promise<unknown>;
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
      /* the next candidate */
    }
  }
  return null;
}

const browser = await launch();
afterAll(async () => {
  await browser?.close();
});

// Opt-in proof: with BOSSMAN_SCRATCH set, one full-page shot per device and state. Never a repo file.
const scratch = process.env.BOSSMAN_SCRATCH;

const company: Company = { id: "c1", name: "App Co", mission: "Reports for clients", paused: false, agents: [{ id: "a1", companyId: "c1", name: "CEO", role: "ceo" as const, agentKind: "claude", model: null, fundingSourceId: null, paused: false, starred: false, duty: null }] };
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/**
 * The step's list drawn with its data given: the real `ConnectList`, so the test draws the rows and an open row's
 * steps themselves, not a hand-written copy of them.
 */
function draw(openId: string | null): string {
  const html = renderToStaticMarkup(
    <ConnectList options={CONNECT_OPTIONS} open={openId} company={company} known={{}} onPick={() => undefined} onSaved={() => undefined} />,
  );
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div class="app"><main><section class="card">${html}</section></main></div></body></html>`;
}

const states = [
  { name: "nothing-chosen", open: null as string | null },
  { name: "plan-open", open: "claude-plan" },
  { name: "signin-plan-open", open: "chatgpt-plan" },
  { name: "key-open", open: "anthropic-key" },
  { name: "other-open", open: "other" },
];

describe.skipIf(!browser)("the setup wizard's connect step, drawn (BOS-2815)", () => {
  it("draws every option as one equal list, and an open row's steps fit the page at each device", async () => {
    const devices = [
      { width: 1550, height: 1000, touch: false, ratio: 1 },
      { width: 1667, height: 724, touch: true, ratio: 1 },
      { width: 390, height: 844, touch: true, ratio: 2 },
    ];
    for (const state of states) {
      const html = draw(state.open);
      expect(html).toContain("setup-connect-row-claude-plan");
      for (const d of devices) {
        const p = await browser!.newPage({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.ratio, hasTouch: d.touch, isMobile: d.touch });
        try {
          await p.setContent(html, { waitUntil: "load" });
          const m = await p.evaluate(
            (expectCount) => {
              const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='setup-connect-row-']"));
              // The closed rows are what must be one size; the open row is its header plus its steps by design.
              const closed = rows.filter((r) => !r.querySelector(".connect-detail"));
              const picks = closed.map((r) => r.querySelector<HTMLElement>(".connect-pick")!.getBoundingClientRect());
              const allPicks = rows.map((r) => r.querySelector<HTMLElement>(".connect-pick")!.getBoundingClientRect());
              const detail = document.querySelector<HTMLElement>(".connect-detail");
              const box = detail?.getBoundingClientRect() ?? null;
              const doc = document.documentElement;
              return {
                count: rows.length,
                heights: [...new Set(picks.map((b) => Math.round(b.height)))],
                widths: [...new Set(picks.map((b) => Math.round(b.width)))],
                minTap: Math.min(...allPicks.map((b) => Math.round(b.height))),
                right: box ? box.right : 0,
                expands: document.querySelectorAll(".connect-pick[aria-expanded='true']").length,
                scrolls: doc.scrollWidth > doc.clientWidth + 1,
                expectCount,
              };
            },
            CONNECT_OPTIONS.length,
          );
          // Every option is drawn, and the rows are one size: equal height and width, so none stands out.
          expect(m.count).toBe(m.expectCount);
          expect(m.heights.length, `rows differ in height at ${d.width} (${state.name})`).toBe(1);
          expect(m.widths.length, `rows differ in width at ${d.width} (${state.name})`).toBe(1);
          // A row is a 44 px tap target on a touch screen.
          if (d.touch) expect(m.minTap, `row under 44 px at ${d.width} (${state.name})`).toBeGreaterThanOrEqual(44);
          // The open row's steps stay inside the page, and exactly one row is open when one should be.
          if (state.open) {
            expect(m.expands).toBe(1);
            expect(m.right).toBeLessThanOrEqual(d.width + 1);
          }
          expect(m.scrolls, `a sideways scroll at ${d.width} (${state.name})`).toBe(false);
          if (scratch) await p.screenshot({ path: (await import("node:path")).join(scratch, `connect-${state.name}-${d.width}.png`) });
        } finally {
          await p.close();
        }
      }
    }
  }, 120_000);
});
