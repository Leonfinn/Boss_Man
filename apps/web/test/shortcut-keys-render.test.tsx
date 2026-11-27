import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { Shortcuts } from "../src/components/Shortcuts";
import { DEFAULT_PREFERENCES, PreferencesContext } from "../src/preferences";
import { PinnedProvider } from "../src/pinned-pages";

// A rendering check of the "?" list's "Your shortcuts in the menu" block (BOS-2669 ticket 4). The real
// Shortcuts component, the real menu provider and the real styles.css are read in a headless browser at the
// owner's two devices (Safari 1550 wide, the Brave foldable 1667×724) and a phone width, with the most shortcuts
// (6) and one long name. It checks the block is there, each row names its number and the shortcut, the long name
// stays on one line inside its row, and nothing runs off the dialog.
//
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `shortcut-keys-list-${name}.png`) : null);

// Six pinned pages, the first two with a name of the owner's own (the long one is the fourth).
const pinnedPages = [
  { id: "updates", name: "Updates" },
  { id: "limits", name: "Checks" },
  { id: "agents" },
  { id: "roadmap", name: "The very long short name an owner can type here for a page" },
  { id: "runs" },
  { id: "skills" },
];

const prefs = { ...DEFAULT_PREFERENCES, pinnedPages };
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${renderToStaticMarkup(
  <PreferencesContext.Provider value={{ prefs, save: async () => prefs }}>
    <PinnedProvider companyId="c1">
      <Shortcuts go={() => {}} hasProjects initialOpen />
    </PinnedProvider>
  </PreferencesContext.Provider>,
)}</body></html>`;

/** What the owner reads in the "Your shortcuts in the menu" block, and whether it fits its row. */
const read = () => {
  const dls = [...document.querySelectorAll("dl.shortcuts-list")];
  const yours = dls.find((dl) => dl.getAttribute("aria-label") === "Your shortcuts in the menu") ?? null;
  const rows = yours
    ? [...yours.querySelectorAll(".shortcuts-row")].map((r) => {
        const el = r as HTMLElement;
        const dt = el.querySelector("dt") as HTMLElement | null;
        const dd = el.querySelector("dd") as HTMLElement | null;
        const box = el.getBoundingClientRect();
        return {
          text: el.innerText.replace(/\s+/g, " ").trim(),
          dtWidth: dt?.getBoundingClientRect().width ?? 0,
          ddHeight: dd?.getBoundingClientRect().height ?? 0,
          // The name stays inside its own row.
          inside: !dd || (dd.getBoundingClientRect().right <= box.right + 0.5),
          overflow: el.scrollWidth - el.clientWidth,
        };
      })
    : [];
  const dialog = document.querySelector(".shortcuts-palette") as HTMLElement | null;
  return { present: !!yours, rows, dialogOverflow: dialog ? dialog.scrollWidth - dialog.clientWidth : 0 };
};

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("the ? list's Your shortcuts in the menu block (BOS-2669 ticket 4)", () => {
  for (const d of devices) {
    it(`${d.name}: six shortcuts show by number with their current names; the longest name stays in its row`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html, { waitUntil: "load" });
        const got = await page.evaluate(read);
        expect(got.present).toBe(true);
        expect(got.rows).toHaveLength(6);
        expect(got.rows[0]!.text).toMatch(/^g then 1 Updates$/);
        expect(got.rows[1]!.text).toMatch(/^g then 2 Checks$/);
        expect(got.rows[2]!.text).toMatch(/^g then 3 Agents$/);
        expect(got.rows[5]!.text).toMatch(/^g then 6 Skills$/);
        for (const row of got.rows) {
          expect(row.dtWidth).toBeGreaterThan(0);
          expect(row.inside).toBe(true);
          expect(row.overflow).toBeLessThanOrEqual(1);
        }
        expect(got.dialogOverflow).toBeLessThanOrEqual(1);
        const path = await shotPath(d.name);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });
  }
});
