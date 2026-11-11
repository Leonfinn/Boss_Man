import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

// Real-browser checks for UI quick wins Q1-Q4 (BOS-1123): the sidebar count is readable, every plain
// field shares one style, the Agents approval dropdown and its help text fit a phone, and a disabled
// button looks disabled. Skipped, not failed, where no browser is installed.

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;

type Page = {
  setContent: (html: string, opts?: { waitUntil?: "load" }) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
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

const SIZES = [
  { name: "desktop 1550", width: 1550, height: 900 },
  { name: "foldable 1667x724", width: 1667, height: 724 },
  { name: "phone 380", width: 380, height: 800 },
];

const LONG = "Hires and edits to any agent's instructions all wait for you, every single time, with no exceptions at all";
const page = `
<div class="app"><nav class="side"><div id="nav-groups" class="nav-groups"><section><ul>
<li><a class="nav" href="#/decisions"><span class="nav-label">Decisions</span><span class="count">4</span></a></li>
</ul></section></div></nav>
<main>
<input id="text" type="text" value="x"><input id="num" type="number" value="3"><input id="search" type="search"><select id="sel"><option>One</option></select>
<button id="dis" class="btn" disabled>Undo last change</button>
<div class="field" style="max-width:560px"><label for="a">What waits for you from the CEO</label>
<select id="a"><option>${LONG}</option></select>
<small class="muted">${LONG} ${LONG} ${LONG}</small></div>
</main></div>`;

const lum = (rgb: string) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe.skipIf(!browser)("UI quick wins Q1-Q4 in a real browser", () => {
  for (const size of SIZES) {
    it(`renders right at ${size.name}`, async () => {
      const p = await browser!.newPage({ viewport: { width: size.width, height: size.height } });
      await p.setContent(html(page), { waitUntil: "load" });
      const r = await p.evaluate(() => {
        const cs = (sel: string) => getComputedStyle(document.querySelector(sel) as HTMLElement);
        const box = (sel: string) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
        const count = cs(".side .count");
        return {
          badgeColor: count.color,
          badgeBg: count.backgroundColor,
          fields: ["#text", "#num", "#search", "#sel"].map((s) => ({ s, h: box(s).height, radius: cs(s).borderTopLeftRadius, bg: cs(s).backgroundColor })),
          disabledOpacity: cs("#dis").opacity,
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          selectRight: box("#a").right,
          smallRight: box(".field small").right,
        };
      });
      await p.close();
      expect(ratio(r.badgeColor, r.badgeBg)).toBeGreaterThanOrEqual(4.5);
      for (const f of r.fields) {
        // On a phone the app already makes dropdowns 44 px for a thumb (styles.css phone block); keep that.
        expect(f.h, f.s).toBe(f.s === "#sel" && size.width < 640 ? 44 : 40);
        expect(f.radius, f.s).toBe("8px");
        expect(f.bg, f.s).toBe("rgb(31, 37, 46)");
      }
      expect(r.disabledOpacity).toBe("0.45");
      expect(r.scrollW).toBeLessThanOrEqual(r.clientW);
      expect(r.selectRight).toBeLessThanOrEqual(r.clientW);
      expect(r.smallRight).toBeLessThanOrEqual(r.clientW);
    });
  }
});
