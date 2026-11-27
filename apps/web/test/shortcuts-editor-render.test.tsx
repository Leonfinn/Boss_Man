import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { OwnerPreferences } from "@boss-man/shared";
import type { Company } from "../src/api";
import { Sidebar } from "../src/components/Sidebar";
import { PinnedProvider } from "../src/pinned-pages";
import { ShortcutsEditor } from "../src/shortcuts-editor";
import { DEFAULT_PREFERENCES, PreferencesContext } from "../src/preferences";

// A rendering check of the Edit shortcuts dialog (BOS-2669 ticket 3). The real dialog and the real styles.css are
// loaded in a headless browser at a phone (390 x 844) and a computer (1550 x 1594): on the phone the dialog is a
// full-screen sheet with Save and Cancel in view and 44 px buttons; on the computer it is about 520 px wide and
// centred. The menu's Edit button sits on the Shortcuts heading's line and inside the menu. Skipped, not failed,
// where no browser is installed.

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
const shotPath = async (name: string) => (scratch ? (await import("node:path")).join(scratch, `shortcuts-editor-${name}.png`) : null);

const company: Company = { id: "c1", name: "Fernleaf Studio", mission: null, paused: false, agents: [] };
const noop = () => {};
const SAVED = [{ id: "updates" }, { id: "limits", name: "Checks and limits for the whole team" }, { id: "agents" }, { id: "runs" }, { id: "funding" }, { id: "roadmap" }];

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div class="app">${body}</div></body></html>`;

const dialogPage = () => html(renderToStaticMarkup(<ShortcutsEditor saved={SAVED} companyId="c1" onSave={async () => true} onClose={noop} />));

const menuPage = () => {
  const prefs: OwnerPreferences = { ...DEFAULT_PREFERENCES, pinnedPages: SAVED };
  return html(
    renderToStaticMarkup(
      <PreferencesContext.Provider value={{ prefs, save: async () => prefs }}>
        <PinnedProvider companyId="c1">
          <Sidebar active="dashboard" companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} collapsed={false} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onLogout={noop} />
        </PinnedProvider>
      </PreferencesContext.Provider>,
    ),
  );
};

const measure = () => {
  const rect = (el: Element | null) => {
    const b = el?.getBoundingClientRect();
    return b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } : null;
  };
  return {
    w: document.documentElement.clientWidth,
    h: document.documentElement.clientHeight,
    dialog: rect(document.querySelector(".shortcut-edit")),
    save: rect(document.querySelector(".shortcut-edit-save")),
    cancel: rect(document.querySelector(".shortcut-edit-foot .btn:not(.primary)")),
    buttons: [...document.querySelectorAll(".shortcut-edit-btn")].map((b) => rect(b)!),
    names: [...document.querySelectorAll(".shortcut-edit-name")].map((b) => rect(b)!),
    rows: document.querySelectorAll(".shortcut-edit-row").length,
    scrollW: document.documentElement.scrollWidth,
    editBtn: rect(document.querySelector(".side-shortcuts-edit")),
    title: rect(document.querySelector(".side-shortcuts-title")),
    side: rect(document.querySelector("nav.side")),
  };
};

const devices = [
  { name: "phone-390x844", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, phone: true },
  { name: "safari-1550x1594", viewport: { width: 1550, height: 1594 }, deviceScaleFactor: 2, hasTouch: false, phone: false },
];

describe.skipIf(!browser)("the Edit shortcuts dialog (BOS-2669 ticket 3)", () => {
  for (const d of devices) {
    it(`${d.name}: ${d.phone ? "a full-screen sheet" : "about 520 px wide, centred"}, Save and Cancel in view, buttons big enough`, async () => {
      const p = await browser!.newPage({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch });
      try {
        await p.setContent(dialogPage(), { waitUntil: "load" });
        const m = await p.evaluate(measure);
        expect(m.rows).toBe(6);
        expect(m.scrollW).toBeLessThanOrEqual(m.w);
        const dlg = m.dialog!;
        // The whole dialog is inside the screen, and Save and Cancel are in view.
        expect(dlg.left).toBeGreaterThanOrEqual(0);
        expect(dlg.right).toBeLessThanOrEqual(m.w);
        expect(dlg.bottom).toBeLessThanOrEqual(m.h);
        for (const b of [m.save!, m.cancel!]) {
          expect(b.bottom).toBeLessThanOrEqual(m.h);
          expect(b.top).toBeGreaterThanOrEqual(dlg.top);
        }
        // Every Move and Remove button is at least 40 px, 44 on a phone; every name box has room for a name.
        for (const b of m.buttons) {
          expect(b.width).toBeGreaterThanOrEqual(d.phone ? 44 : 40);
          expect(b.height).toBeGreaterThanOrEqual(d.phone ? 44 : 40);
          expect(b.right).toBeLessThanOrEqual(dlg.right);
        }
        for (const n of m.names) expect(n.width).toBeGreaterThanOrEqual(d.phone ? 150 : 250);
        if (d.phone) {
          expect(dlg.width).toBe(m.w);
          expect(dlg.height).toBe(m.h);
        } else {
          expect(dlg.width).toBe(520);
          expect(Math.abs((dlg.left + dlg.right) / 2 - m.w / 2)).toBeLessThan(1);
        }
        const shot = await shotPath(d.name);
        if (shot) await p.screenshot({ path: shot });
      } finally {
        await p.close();
      }
    });
  }

  it("the menu's Edit button sits on the Shortcuts heading's line, inside the menu", async () => {
    const p = await browser!.newPage({ viewport: { width: 1550, height: 1594 } });
    try {
      await p.setContent(menuPage(), { waitUntil: "load" });
      const m = await p.evaluate(measure);
      expect(m.editBtn).toBeTruthy();
      expect(m.editBtn!.right).toBeLessThanOrEqual(m.side!.right);
      expect(Math.abs((m.editBtn!.top + m.editBtn!.bottom) / 2 - (m.title!.top + m.title!.bottom) / 2)).toBeLessThan(8);
    } finally {
      await p.close();
    }
  });
});
