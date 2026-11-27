import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { OwnerPreferences } from "@boss-man/shared";
import type { Company } from "../src/api";
import { Sidebar } from "../src/components/Sidebar";
import { PinnedProvider, AddToShortcuts } from "../src/pinned-pages";
import { DEFAULT_PREFERENCES, PreferencesContext } from "../src/preferences";

// A rendering check of the menu's Shortcuts section and the "Add to shortcuts" chip (BOS-2669 ticket 2). The real
// Sidebar and the real styles.css are loaded in a headless browser at the owner's devices (Brave 1667x724 touch,
// Safari 1550x1594, a 390 px phone) and the rows are measured: with no shortcuts the menu is exactly today's,
// with the most shortcuts (6) the top block and the pinned Settings and Log out stay in view, and the chip sits on
// the title's line and inside the screen. Skipped, not failed, where no browser is installed.

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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `shortcuts-menu-${name}.png`) : null);

const company: Company = { id: "c1", name: "Fernleaf Studio", mission: null, paused: false, agents: [] };
const noop = () => {};
const SIX = ["updates", "limits", "agents", "runs", "funding", "roadmap"].map((id) => ({ id }));

const page = (collapsed: boolean, pinnedPages: { id: string; name?: string }[], withChip = false) => {
  const prefs: OwnerPreferences = { ...DEFAULT_PREFERENCES, pinnedPages };
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="app${collapsed ? " side-collapsed" : ""}">` +
    renderToStaticMarkup(
      <PreferencesContext.Provider value={{ prefs, save: async () => prefs }}>
        <PinnedProvider companyId="c1">
          <Sidebar active="dashboard" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} collapsed={collapsed} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onLogout={noop} />
          {withChip && (
            <main>
              <header className="page-head">
                <div>
                  <p className="label">Fernleaf Studio</p>
                  <h1>Roadmap</h1>
                  <AddToShortcuts page="roadmap" />
                  <p className="sub">What is planned.</p>
                </div>
              </header>
            </main>
          )}
        </PinnedProvider>
      </PreferencesContext.Provider>,
    ) +
    "</div></body></html>"
  );
};

const measure = () => {
  const rect = (el: Element | null) => {
    const b = el?.getBoundingClientRect();
    return b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null;
  };
  const rows = [...document.querySelectorAll(".nav-scroll a.nav, .nav-scroll button.nav")].map((el) => ({ text: (el.textContent ?? "").trim(), ...rect(el)! }));
  const shortcutRows = [...document.querySelectorAll(".side-shortcuts a.nav")].map((el) => ({ text: (el.textContent ?? "").trim(), ...rect(el)! }));
  const h = document.documentElement.clientHeight;
  const w = document.documentElement.clientWidth;
  const h1 = rect(document.querySelector(".page-head h1"));
  const chip = rect(document.querySelector(".pin-chip"));
  return {
    sections: document.querySelectorAll(".side-shortcuts").length,
    rows,
    shortcutRows,
    logout: rect(document.querySelector(".side-pinned .logout")),
    settings: rect(document.querySelector(".side-pinned a.nav")),
    h1,
    chip,
    chipText: document.querySelector(".pin-chip")?.textContent ?? null,
    h,
    w,
  };
};

const devices = [
  { name: "brave-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true, collapsed: false },
  { name: "safari-1550", viewport: { width: 1550, height: 1594 }, deviceScaleFactor: 2, collapsed: false },
  { name: "strip-1667x724", viewport: { width: 1667, height: 724 }, deviceScaleFactor: 3, hasTouch: true, collapsed: true },
];

describe.skipIf(!browser)("the menu's Shortcuts section and the Add to shortcuts chip (BOS-2669)", () => {
  for (const d of devices) {
    it(`${d.name}: no shortcuts means no section; 6 shortcuts keep the top block and Settings and Log out in view`, async () => {
      const p = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch });
      try {
        await p.setContent(page(d.collapsed, []), { waitUntil: "load" });
        const none = await p.evaluate(measure);
        expect(none.sections).toBe(0);
        const noneTops = none.rows.map((r) => [r.text, r.top, r.bottom]);

        await p.setContent(page(d.collapsed, SIX), { waitUntil: "load" });
        const six = await p.evaluate(measure);
        expect(six.sections).toBe(1);
        expect(six.shortcutRows).toHaveLength(6);
        // The menu draws once and does not move: the same measure a moment later is identical.
        const later = await p.evaluate(measure);
        expect(later.rows).toEqual(six.rows);
        // Every shortcut row and the top block (Dashboard, Decisions, Notifications, Chat) are fully in view.
        for (const name of ["Dashboard", "Decisions", "Notifications", "Chat"]) {
          const r = six.rows.find((x) => (d.collapsed ? true : x.text.startsWith(name)));
          expect(r, name).toBeTruthy();
        }
        for (const r of six.rows.slice(0, 10)) {
          expect(r.top).toBeGreaterThanOrEqual(0);
          expect(r.bottom).toBeLessThanOrEqual(six.h + 0.5);
        }
        // Settings and Log out stay in the screen.
        expect(six.settings!.bottom).toBeLessThanOrEqual(six.h + 0.5);
        expect(six.logout!.bottom).toBeLessThanOrEqual(six.h + 0.5);
        // With nothing pinned the rows are the old rows: the six shortcut rows are the only difference.
        expect(six.rows.length).toBe(none.rows.length + 6);
        expect(noneTops.length).toBeGreaterThan(0);
        const path = await shotPath(d.name);
        if (path) await p.screenshot({ path });
      } finally {
        await p.close();
      }
    });
  }

  it("phone 390x844: the sheet lists the shortcuts first and Settings and Log out are in the sheet", async () => {
    const p = await browser!.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true });
    try {
      await p.setContent(page(false, SIX), { waitUntil: "load" });
      await p.evaluate(() => {
        document.querySelector("#nav-groups")?.classList.add("open");
      });
      const got = await p.evaluate(measure);
      expect(got.shortcutRows).toHaveLength(6);
      // The shortcuts are the first rows of the sheet, each at least 44 px tall.
      expect(got.rows[0]!.text).toBe(got.shortcutRows[0]!.text);
      for (const r of got.shortcutRows) expect(r.bottom - r.top).toBeGreaterThanOrEqual(44);
      expect(got.settings).not.toBeNull();
      expect(got.logout).not.toBeNull();
      const path = await shotPath("phone-390");
      if (path) await p.screenshot({ path });
    } finally {
      await p.close();
    }
  });

  for (const d of [{ name: "desktop-1550", width: 1550, height: 1594 }, { name: "phone-380", width: 380, height: 800 }]) {
    it(`${d.name}: the Add to shortcuts chip sits beside the title inside the screen`, async () => {
      const p = await browser!.newPage({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: 2 });
      try {
        await p.setContent(page(false, [], true), { waitUntil: "load" });
        const got = await p.evaluate(measure);
        expect(got.chipText).toBe("Add to shortcuts");
        expect(got.chip!.right).toBeLessThanOrEqual(got.w + 0.5);
        expect(got.chip!.left).toBeGreaterThanOrEqual(0);
        if (d.width > 640) {
          // Desktop: on the title's line, to its right.
          expect(got.chip!.left).toBeGreaterThanOrEqual(got.h1!.right);
          expect(Math.abs((got.chip!.top + got.chip!.bottom) / 2 - (got.h1!.top + got.h1!.bottom) / 2)).toBeLessThan(20);
        }
        const path = await shotPath(`chip-${d.name}`);
        if (path) await p.screenshot({ path });
      } finally {
        await p.close();
      }
    });
  }

  it("a pinned page an update removed shows as a gone row with its words", async () => {
    const p = await browser!.newPage({ viewport: { width: 1550, height: 1594 } });
    try {
      await p.setContent(page(false, [{ id: "updates" }, { id: "old-page", name: "Old page" }]), { waitUntil: "load" });
      const got = await p.evaluate(() => ({
        rows: [...document.querySelectorAll(".side-shortcuts a.nav")].map((el) => ({ text: (el.textContent ?? "").trim(), href: el.getAttribute("href") })),
      }));
      expect(got.rows[1]!.text).toContain("Page no longer exists");
      expect(got.rows[1]!.href).toBe("#/shortcut-gone/old-page");
    } finally {
      await p.close();
    }
  });
});
