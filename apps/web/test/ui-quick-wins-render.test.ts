import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { launch } from "./real-page";

// Real-browser checks for UI quick wins Q1-Q4 (BOS-1123): the sidebar count is readable, every plain
// field shares one style, the Agents approval dropdown and its help text fit a phone, and a disabled
// button looks disabled. Skipped on a dev machine with no browser; fails at the merge gate (see below).

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

// The shared launcher passes the flags the fenced check job needs (BOS-1095) and logs why a launch failed.
const browser = (await launch()) as Browser | null;
// Skipped only on a dev machine with no browser. At the merge gate it must run, so a missing browser fails there.
if (!browser && process.env.BOSSMAN_MERGE_CHECK) {
  throw new Error("ui-quick-wins-render: no chromium/playwright found at the merge gate; this test must run there");
}
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
<textarea id="ta">x</textarea>
<div class="field"><input id="fin" type="text" value="x"><select id="fsel"><option>One</option></select></div>
<div class="rm-pin"><select id="pin"><option>One</option></select></div>
<div class="rename"><input id="ren" type="text" value="x"></div>
<button id="dis" class="btn" disabled>Undo last change</button>
<div class="field" style="max-width:560px"><label for="a">What waits for you from the CEO</label>
<select id="a"><option>${LONG}</option></select>
<small class="muted">${LONG} ${LONG} ${LONG}</small></div>
</main></div>`;

const lum = (rgb: string) => {
  const [r = 0, g = 0, b = 0] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
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
          // Plain fields plus the real class names that used to differ (.field, .rm-pin, .rename).
          fields: ["#text", "#num", "#search", "#sel", "#ta", "#fin", "#fsel", "#pin", "#ren"].map((s) => ({ s, h: box(s).height, radius: cs(s).borderTopLeftRadius, bg: cs(s).backgroundColor, tag: (document.querySelector(s) as HTMLElement).tagName })),
          fieldColour: (() => {
            const probe = document.createElement("div");
            probe.style.backgroundColor = "var(--field)";
            document.body.appendChild(probe);
            return getComputedStyle(probe).backgroundColor;
          })(),
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
        const phoneSelect = f.tag === "SELECT" && size.width < 640;
        if (f.tag === "TEXTAREA") expect(f.h, f.s).toBeGreaterThanOrEqual(40);
        else if (phoneSelect) expect([40, 44], f.s).toContain(f.h); // phone block lifts some dropdowns to 44 for a thumb
        else expect(f.h, f.s).toBe(40);
        expect(f.radius, f.s).toBe("8px");
        expect(f.bg, f.s).toBe(r.fieldColour);
      }
      expect(r.disabledOpacity).toBe("0.45");
      expect(r.scrollW).toBeLessThanOrEqual(r.clientW);
      expect(r.selectRight).toBeLessThanOrEqual(r.clientW);
      expect(r.smallRight).toBeLessThanOrEqual(r.clientW);
    });
  }
});
