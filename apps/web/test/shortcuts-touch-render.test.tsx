import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { Shortcuts } from "../src/components/Shortcuts";

// BOS-2761: the shortcuts list says "These need a keyboard." on a screen with no mouse (any-pointer: fine is
// false), and not on one with a mouse. Rendered with the real styles.css in a headless browser at the owner's
// two windows. Skipped, not failed, where no browser is installed. (The Tab trap is in keyboard-shortcuts-tab.test.tsx.)

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `shortcuts-touch-${name}.png`) : null);

const htmlFor = (noMouse: boolean) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="app">${renderToStaticMarkup(
  <Shortcuts go={() => {}} hasProjects initialOpen onTurnKeysOn={() => {}} noMouse={noMouse} />,
)}</div></body></html>`;

const measure = () => {
  const dialog = document.querySelector(".shortcuts-palette")!.getBoundingClientRect();
  const note = document.querySelector(".shortcuts-note")!;
  const n = note.getBoundingClientRect();
  return {
    coarseOnly: !matchMedia("(any-pointer: fine)").matches,
    noteText: note.textContent ?? "",
    noteInDialog: n.top >= dialog.top - 0.5 && n.bottom <= dialog.bottom + 0.5 && n.right <= dialog.right + 0.5,
    noteInView: n.bottom <= window.innerHeight && n.right <= window.innerWidth,
  };
};

const cases = [
  { name: "safari-mouse-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2, touchOnly: false },
  { name: "brave-touch-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, touchOnly: true },
  { name: "phone-touch-380", viewport: { width: 380, height: 800 }, deviceScaleFactor: 2, touchOnly: true },
];

describe.skipIf(!browser)("shortcuts list on touch screens (BOS-2761)", () => {
  for (const c of cases) {
    it(`${c.name}: the line shows only with no mouse, and stays inside the dialog`, async () => {
      const p = await browser!.newPage({ viewport: c.viewport, deviceScaleFactor: c.deviceScaleFactor, hasTouch: c.touchOnly, isMobile: c.touchOnly });
      try {
        await p.setContent(htmlFor(c.touchOnly), { waitUntil: "load" });
        const m = await p.evaluate(measure);
        // The browser's own pointer test agrees with the case (a touch device with no mouse), and the line follows it.
        expect(m.coarseOnly).toBe(c.touchOnly);
        expect(m.noteText.startsWith("These need a keyboard.")).toBe(c.touchOnly);
        expect(m.noteInDialog).toBe(true);
        expect(m.noteInView).toBe(true);
        const path = await shotPath(c.name);
        if (path) await p.screenshot({ path });
      } finally {
        await p.close();
      }
    });
  }
});
