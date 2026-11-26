import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { Company } from "../src/api";
import { Sidebar } from "../src/components/Sidebar";

// BOS-2745: the expanded side menu has one width on every screen. It renders the real Sidebar with the
// real styles.css in a headless browser, beside the page shapes of Chat (the baseline), Settings, the
// board, the wiki and the tickets list, and compares the menu's width at the same window size.
// Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  screenshot: (opts: { path: string }) => Promise<unknown>;
  close: () => Promise<void>;
};
type Browser = {
  newPage: (opts?: { viewport?: { width: number; height: number } }) => Promise<Page>;
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
const company: Company = { id: "c1", name: "Fernleaf Studio", mission: null, paused: false, agents: [], projects: [] };
const noop = () => {};
const side = (active: string) =>
  renderToStaticMarkup(
    <Sidebar active={active} companies={[company]} current={company} decisions={[]} unread={0} feedback={0} mergeWaiting={0} mergeStuck={0} collapsed={false} narrow={false} onToggleCollapsed={noop} onPickCompany={noop} onCreateCompany={async () => {}} onLogout={noop} />,
  );

const wide = `<div style="width:2400px;height:300px">wide content</div>`;
const screens: { name: string; active: string; main: string }[] = [
  { name: "chat", active: "chat", main: `<div class="chat-page"><div class="messenger">chat</div></div>` },
  { name: "settings", active: "settings", main: `<div class="set-layout">${wide}</div>` },
  { name: "board", active: "board", main: wide },
  { name: "wiki", active: "wiki", main: `<div class="wiki">${wide}</div>` },
  { name: "tickets", active: "tickets", main: `<div class="table-wrap"><table><tbody><tr><td>${wide}</td></tr></tbody></table></div>` },
];
const html = (s: { active: string; main: string }) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="app">${side(s.active)}<main>${s.main}</main></div></body></html>`;

const measure = () => {
  const nav = document.querySelector("nav.side")!.getBoundingClientRect();
  const set = document.querySelector(".side-pinned a.nav");
  const label = set?.querySelector(".nav-label")?.getBoundingClientRect();
  return { width: nav.width, labelWidth: label?.width ?? 0 };
};

describe.skipIf(!browser)("the expanded side menu has one width on every screen (BOS-2745)", () => {
  for (const size of [{ width: 1550, height: 900 }, { width: 1280, height: 800 }, { width: 1000, height: 800 },{ width: 1667, height: 724 }]) {
    it(`${size.width}px window: Settings, board, wiki and tickets match Chat`, async () => {
      const widths: Record<string, number> = {};
      for (const s of screens) {
        const p = await browser!.newPage({ viewport: size });
        try {
          await p.setContent(html(s), { waitUntil: "load" });
          const m = await p.evaluate(measure);
          widths[s.name] = m.width;
          if (scratch) await p.screenshot({ path: `${scratch}/sidebar-width-${s.name}-${size.width}.png` });
        } finally {
          await p.close();
        }
      }
      for (const s of screens) expect(widths[s.name], `${s.name} menu width (chat is ${widths.chat})`).toBeCloseTo(widths.chat!, 0);
    });
  }
});
