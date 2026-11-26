import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { Company } from "../src/api";
import { Sidebar } from "../src/components/Sidebar";

// A rendering check of the menu's keyboard button (BOS-2688). It renders the real Sidebar with the real
// styles.css in a headless browser and measures the pinned bottom row (Settings, keyboard, Log out) at the
// owner's two devices (Safari 1550 wide, the Brave foldable 1667×724), in the collapsed icon strip and at
// phone width, where the button is hidden. Skipped, not failed, where no browser is installed.

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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `sidebar-shortcuts-${name}.png`) : null);

const company: Company = { id: "c1", name: "Fernleaf Studio", mission: null, paused: false, agents: [], projects: [] };
const noop = () => {};
const markup = (collapsed: boolean) =>
  renderToStaticMarkup(
    <Sidebar active="dashboard" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} collapsed={collapsed} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onLogout={noop} />,
  );
const page = (collapsed: boolean) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="app${collapsed ? " side-collapsed" : ""}">${markup(collapsed)}</div></body></html>`;

const measure = () => {
  const r = (el: Element | null) => {
    const b = el?.getBoundingClientRect();
    return b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } : null;
  };
  const k = document.querySelector(".side-pinned .shortcuts-button");
  const out = document.querySelector(".side-pinned .logout");
  const set = document.querySelector(".side-pinned a.nav");
  const nav = document.querySelector("nav.side");
  return {
    shown: !!k && getComputedStyle(k).display !== "none",
    key: r(k),
    logout: r(out),
    settings: r(set),
    side: r(nav),
    name: k?.getAttribute("aria-label") ?? null,
    title: k?.getAttribute("title") ?? null,
    hint: document.querySelector('a.nav[href="#/decisions"]')?.getAttribute("title") ?? null,
    viewH: window.innerHeight,
  };
};

const devices = [
  { name: "safari-1550", viewport: { width: 1550, height: 1611 }, deviceScaleFactor: 2, collapsed: false },
  { name: "brave-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true, collapsed: false },
  { name: "strip-1550", viewport: { width: 1550, height: 900 }, deviceScaleFactor: 2, collapsed: true },
  { name: "strip-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true, collapsed: true },
  { name: "phone-380", viewport: { width: 380, height: 800 }, deviceScaleFactor: 2, hasTouch: true, collapsed: false },
];

describe.skipIf(!browser)("the menu's keyboard button in a real browser (BOS-2688)", () => {
  for (const d of devices) {
    it(`${d.name}: bottom row fits, in view, button sized like Log out`, async () => {
      const p = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch });
      try {
        await p.setContent(page(d.collapsed), { waitUntil: "load" });
        const m = await p.evaluate(measure);
        expect(m.name).toBe("Keyboard shortcuts");
        expect(m.title).toBe("Keyboard shortcuts (?)");
        expect(m.hint).toBe("Decisions (g then i)");
        if (d.name.startsWith("phone")) {
          // The Menu sheet keeps Settings and Log out only.
          expect(m.shown).toBe(false);
        } else {
          expect(m.shown).toBe(true);
          const k = m.key!;
          const out = m.logout!;
          // Same 44-px-high square as Log out, in the row's bottom, inside the window.
          expect(k.height).toBe(44);
          expect(Math.abs(k.height - out.height)).toBeLessThanOrEqual(0.5);
          if (!d.collapsed) {
            expect(k.width).toBe(44);
            // Order: Settings, keyboard, Log out, on one line, with no overlap.
            expect(m.settings!.right).toBeLessThanOrEqual(k.left + 0.5);
            expect(k.right).toBeLessThanOrEqual(out.left + 0.5);
            expect(Math.abs(k.top - out.top)).toBeLessThanOrEqual(0.5);
          } else {
            // In the strip it stacks between Settings and Log out.
            expect(m.settings!.bottom).toBeLessThanOrEqual(k.top + 0.5);
            expect(k.bottom).toBeLessThanOrEqual(out.top + 0.5);
          }
          expect(out.bottom).toBeLessThanOrEqual(m.viewH);
          expect(k.left).toBeGreaterThanOrEqual(m.side!.left);
          expect(k.right).toBeLessThanOrEqual(m.side!.right + 0.5);
        }
        const path = await shotPath(d.name);
        if (path) await p.screenshot({ path });
      } finally {
        await p.close();
      }
    });
  }
});
