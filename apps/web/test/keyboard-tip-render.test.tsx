import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { Company } from "../src/api";
import { Shortcuts } from "../src/components/Shortcuts";
import { Sidebar } from "../src/components/Sidebar";

// A rendering check of the one-time keyboard tip beside the menu (BOS-2769). The first-time tip used to sit
// at the bottom left, over Settings, the keyboard button and Log out on a short window (the owner's Brave at
// 1667x724). This renders the real Sidebar under the real tip with the real styles.css in a headless browser
// and checks the tip never overlaps the menu's pinned bottom row at the owner's two devices, with the menu
// full and folded to its 64 px icon strip. Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; hasTouch?: boolean }) => Promise<Page>;
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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `keyboard-tip-${name}.png`) : null);

const company: Company = { id: "c1", name: "Fernleaf Studio", mission: null, paused: false, agents: [] };
const noop = () => {};
const page = (collapsed: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="app${collapsed ? " side-collapsed" : ""}">` +
  renderToStaticMarkup(
    <Sidebar active="dashboard" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} collapsed={collapsed} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onLogout={noop} />,
  ) +
  renderToStaticMarkup(<Shortcuts go={() => {}} hasProjects keyboardTipSeen={false} onTipSeen={() => {}} initialTip />) +
  "</div></body></html>";

const measure = () => {
  const rect = (el: Element | null) => {
    const b = el?.getBoundingClientRect();
    return b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null;
  };
  const tip = rect(document.querySelector(".shortcuts-tip"));
  const pinned = [...document.querySelectorAll(".side-pinned > *")];
  const key = rect(document.querySelector(".side-pinned .shortcuts-button"));
  const out = rect(document.querySelector(".side-pinned .logout"));
  const settings = rect(document.querySelector(".side-pinned a.nav"));
  const hits = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
    !!a && !!b && !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  return {
    hasTip: !!tip,
    // The tip and the menu's pinned row don't touch at all.
    overlapsPinned: pinned.some((el) => hits(tip, rect(el))),
    // The whole tip is on screen.
    inside: !!tip && tip.left >= 0 && tip.right <= document.documentElement.clientWidth + 0.5 && tip.top >= 0 && tip.bottom <= document.documentElement.clientHeight + 0.5,
    tip,
    key,
    logout: out,
    settings,
  };
};

const devices = [
  { name: "brave-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true, collapsed: false },
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2, collapsed: false },
  { name: "strip-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true, collapsed: true },
];

describe.skipIf(!browser)("the one-time tip stays clear of the menu's pinned row (BOS-2769)", () => {
  for (const d of devices) {
    it(`${d.name}: the tip never covers Settings, the keyboard button or Log out`, async () => {
      const p = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch });
      try {
        await p.setContent(page(d.collapsed), { waitUntil: "load" });
        const got = await p.evaluate(measure);
        expect(got.hasTip).toBe(true);
        expect(got.overlapsPinned).toBe(false);
        expect(got.inside).toBe(true);
        // Beside the menu's column (240 px wide, or the 64 px strip when folded), not over it.
        const menuWidth = d.collapsed ? 64 : 240;
        expect(got.tip!.left).toBeGreaterThanOrEqual(menuWidth);
        if (!d.collapsed) {
          // The expanded menu has the pinned row along its bottom: the tip sits above it, so the row stays readable.
          expect(got.tip!.bottom).toBeLessThanOrEqual(got.key!.top);
        }
        const path = await shotPath(d.name);
        if (path) await p.screenshot({ path });
      } finally {
        await p.close();
      }
    });
  }
});
