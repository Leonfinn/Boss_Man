import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { BeforeStep } from "../src/pages/Setup";

// BOS-2818: the "Before you go" step and the checklist (one column, top to bottom) with the real
// styles.css in a headless browser at a desktop and a 380px phone width: nothing runs off the page,
// the rows sit one under another, and the wizard button of Settings shows at a wide width.
// Skipped, not failed, where no browser is installed (CI's web-browser job fails on a skip).

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

const items = [
  { id: "company", label: "Say what the company is for", done: true },
  { id: "runner", label: "Start the runner", done: true },
  { id: "credential", label: "Add a Claude sign-in code", done: false },
  { id: "funding", label: "Choose what pays for the CEO", done: false },
];

describe.skipIf(!browser)("setup before-you-go and checklist, in a browser", () => {
  for (const [name, width] of [["desktop-1440", 1440], ["wide-1667", 1667], ["phone", 390]] as const) {
    it(`fits at ${name} width, rows one under another, wizard button shown`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 900 } });
      const list = items.map((i) => `<li class="${i.done ? "done" : ""}"><span aria-hidden="true">${i.done ? "✓" : "○"}</span> ${i.label}</li>`).join("");
      const html = `<!doctype html><html><head><style>${css}</style></head><body><main class="card">${renderToStaticMarkup(<BeforeStep items={items} onFix={() => {}} />)}</main><section class="card"><p class="setup-count">Setup: 2 of 4 done</p><ul class="checklist">${list}</ul></section><div class="set-head-wizard"><button class="btn">Run the setup wizard</button></div></body></html>`;
      await page.setContent(html, { waitUntil: "load" });
      if (scratch) await page.screenshot({ path: `${scratch}/setup-before-${name}.png`, fullPage: true });
      const m = await page.evaluate(() => {
        const lis = [...document.querySelectorAll(".checklist li")].map((e) => e.getBoundingClientRect());
        const btn = document.querySelector(".set-head-wizard .btn")!.getBoundingClientRect();
        const fixes = [...document.querySelectorAll(".setup-before .btn")].map((e) => e.getBoundingClientRect());
        return { lis: lis.map((r) => ({ top: r.top, left: r.left })), btnW: btn.width, fixes: fixes.map((r) => r.right), scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, text: document.body.innerText };
      });
      await page.close();
      expect(m.lis).toHaveLength(4);
      for (let i = 1; i < m.lis.length; i++) expect(m.lis[i]!.top).toBeGreaterThan(m.lis[i - 1]!.top + 10);
      // The top-right copy shows on a wide screen (F21); a phone shows the copy under the menu instead.
      if (width >= 900) expect(m.btnW).toBeGreaterThan(0);
      expect(m.fixes).toHaveLength(2);
      expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
      for (const r of m.fixes) expect(r).toBeLessThanOrEqual(m.innerW);
      expect(m.text).toContain("treated as No");
    });
  }
});
