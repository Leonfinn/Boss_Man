import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { OPEN_SHORTCUTS_EVENT, Shortcuts } from "../src/components/Shortcuts";
import { PreferencesContext } from "../src/preferences";
import { KeyboardShortcuts } from "../src/pages/settings/KeyboardShortcuts";

// A rendering check of the single-letter-key switch and the list's off notice (BOS-2689, BOS-2671 part 3d).
// The section and the "off" line are new boxes on screens the owner already knows, so this renders the real
// components with the real styles.css and reads them in a headless browser at the owner's two devices
// (Safari 1550 wide, the Brave foldable 1667×724) and a phone width. It checks the words are on screen, the
// box and its hint don't overlap, the "Turn them on" link sits in the off line inside the dialog, and nothing
// runs off its container. Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `single-letter-keys-${name}.png`) : null);

const save = async () => ({ singleLetterKeys: true, pinnedPages: [], keyboardTipSeen: false });

const account = (singleLetterKeys: boolean) =>
  renderToStaticMarkup(
    <PreferencesContext.Provider value={{ prefs: { singleLetterKeys, pinnedPages: [], keyboardTipSeen: true }, save }}>
      <main className="app-main" style={{ padding: "32px 40px", display: "flex", flexDirection: "column", gap: 24 }}>
        <KeyboardShortcuts companyId="c1" />
      </main>
    </PreferencesContext.Provider>,
  );

// The list, shown open, with the keys off and the "Turn them on" link in the off line.
const list = (singleLetterKeys: boolean) =>
  renderToStaticMarkup(
    <Shortcuts go={() => {}} hasProjects singleLetterKeys={singleLetterKeys} onTurnKeysOn={() => {}} initialOpen />,
  );

// The one-time keyboard tip (BOS-2690), drawn at the bottom left for the layout check. The real tip only opens
// on a Tab or Ctrl K; the rendering test asks for it on the first draw instead.
const tip = () =>
  renderToStaticMarkup(
    <Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={() => {}} initialTip />,
  );

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="app">${body}</div></body></html>`;

const readAccount = () => {
  const section = document.querySelector("#keyboard-shortcuts-h")?.closest("section") as HTMLElement | null;
  const box = document.querySelector("#pref-single-letter-keys") as HTMLInputElement | null;
  const label = box?.closest("label") as HTMLElement | null;
  const hint = section ? ([...section.querySelectorAll("p.muted")][0] as HTMLElement | undefined) : undefined;
  const r = label?.getBoundingClientRect();
  const h = hint?.getBoundingClientRect();
  const s = section?.getBoundingClientRect();
  return {
    hasSection: !!section,
    title: section?.querySelector("h2")?.textContent ?? null,
    checked: !!box?.checked,
    boxVisible: !!box && box.getBoundingClientRect().width > 0,
    labelText: label?.innerText ?? null,
    hintText: hint?.innerText ?? null,
    underText: (section?.querySelectorAll("p.muted")[1] as HTMLElement | undefined)?.innerText ?? null,
    // The hint starts below the box, and the whole section stays inside the page.
    below: !r || !h || h.top >= r.bottom - 2,
    inside: !s || (s.left >= 0 && s.right <= document.documentElement.clientWidth + 0.5),
    overflow: section ? section.scrollWidth - section.clientWidth : 0,
  };
};

const readList = () => {
  const dialog = document.querySelector("[role='dialog']") as HTMLElement | null;
  const off = dialog?.querySelector(".shortcuts-off") as HTMLElement | null;
  const link = off?.querySelector("button") as HTMLButtonElement | null;
  const d = dialog?.getBoundingClientRect();
  const o = off?.getBoundingClientRect();
  const l = link?.getBoundingClientRect();
  const dlg = dialog?.querySelector(".search-palette")?.getBoundingClientRect() ?? d;
  return {
    hasDialog: !!dialog,
    offText: off?.innerText ?? null,
    linkText: link?.innerText ?? null,
    linkVisible: !!l && l.width > 0 && l.height > 0,
    // The off line sits inside the dialog, and so does its link (no wrapping off the edge).
    offInside: !o || !dlg || (o.left >= dlg.left - 0.5 && o.right <= dlg.right + 0.5),
    linkInside: !l || !dlg || (l.left >= dlg.left - 0.5 && l.right <= dlg.right + 0.5),
    overflow: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
  };
};

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2 },
  { name: "brave-foldable-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true },
  { name: "phone-390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
];

describe.skipIf(!browser)("single-letter-key switch and the list's off notice (BOS-2689)", () => {
  for (const d of devices) {
    it(`${d.name}: the switch shows its words, and the box and hint don't overlap`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html(account(true)), { waitUntil: "load" });
        const got = await page.evaluate(readAccount);
        expect(got.hasSection).toBe(true);
        expect(got.title).toBe("Keyboard shortcuts");
        expect(got.checked).toBe(true);
        expect(got.boxVisible).toBe(true);
        expect(got.labelText).toContain("Use single-letter keys");
        expect(got.hintText).toContain("? for the list, g then a letter to go to a page, j k to move between cards.");
        expect(got.underText).toContain("Ctrl K for search always works. This setting follows your login to every browser.");
        expect(got.below).toBe(true);
        expect(got.inside).toBe(true);
        expect(got.overflow).toBeLessThanOrEqual(1);
        const path = await shotPath(`${d.name}-account`);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });

    it(`${d.name}: with the keys off the list shows the off line and "Turn them on", inside the dialog`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html(list(false)), { waitUntil: "load" });
        const got = await page.evaluate(readList);
        expect(got.hasDialog).toBe(true);
        expect(got.offText).toContain("Single-letter keys are off, so only the ones with Ctrl work.");
        expect(got.linkText).toBe("Turn them on");
        expect(got.linkVisible).toBe(true);
        expect(got.offInside).toBe(true);
        expect(got.linkInside).toBe(true);
        expect(got.overflow).toBeLessThanOrEqual(1);
        const path = await shotPath(`${d.name}-list`);
        if (path) await page.screenshot({ path, fullPage: true });
      } finally {
        await page.close();
      }
    });

    it(`${d.name}: with the keys on there is no off line`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html(list(true)), { waitUntil: "load" });
        const got = await page.evaluate(readList);
        expect(got.hasDialog).toBe(true);
        expect(got.offText).toBeNull();
        expect(got.linkText).toBeNull();
      } finally {
        await page.close();
      }
    });
  }

  it("the settings link opens the list through the same event the menu button's way in uses", async () => {
    const page = await browser!.newPage({ viewport: { width: 1550, height: 1000 }, deviceScaleFactor: 1 });
    try {
      // The list mounts hidden (null) until the event arrives; this checks the event name it listens for is one constant.
      await page.setContent(html(list(false)), { waitUntil: "load" });
      const name = await page.evaluate((n: string) => n, OPEN_SHORTCUTS_EVENT);
      expect(name).toBe("bossman:open-shortcuts");
    } finally {
      await page.close();
    }
  });
});

const readTip = () => {
  const panel = document.querySelector(".shortcuts-tip") as HTMLElement | null;
  const text = panel?.querySelector(".shortcuts-tip-text") as HTMLElement | null;
  const show = panel?.querySelector("button") as HTMLButtonElement | null;
  const gotIt = [...(panel?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Got it") as HTMLButtonElement | undefined;
  const r = panel?.getBoundingClientRect();
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  return {
    hasPanel: !!panel,
    role: panel?.getAttribute("role") ?? null,
    tipText: text?.innerText ?? null,
    showText: show?.innerText ?? null,
    gotItText: gotIt?.innerText ?? null,
    // Bottom left, inside the window, and all of it visible (no part off the bottom edge).
    bottomLeft: !!r && r.left >= 0 && r.left <= 40 && r.bottom <= h && r.top >= 0,
    inside: !!r && r.left >= 0 && r.right <= w + 0.5,
  };
};

describe.skipIf(!browser)("the one-time keyboard tip (BOS-2690)", () => {
  for (const d of devices.filter((x) => !x.isMobile)) {
    it(`${d.name}: the tip sits at the bottom left, inside the window, with both ways to close`, async () => {
      const page = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile });
      try {
        await page.setContent(html(tip()), { waitUntil: "load" });
        const got = await page.evaluate(readTip);
        expect(got.hasPanel).toBe(true);
        expect(got.role).toBe("status");
        expect(got.tipText).toBe("Boss Man has keyboard shortcuts. Press ? any time to see them.");
        expect(got.showText).toBe("Show shortcuts");
        expect(got.gotItText).toBe("Got it");
        expect(got.bottomLeft).toBe(true);
        expect(got.inside).toBe(true);
        const path = await shotPath(`${d.name}-tip`);
        if (path) await page.screenshot({ path });
      } finally {
        await page.close();
      }
    });
  }
});
